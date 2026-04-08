import type { Tool, Tools, ToolUseContext, PermissionResult } from './Tool.js'
import type { TaskType, TaskStatus, TaskPriority } from './Task.js'
import { isTerminalTaskStatus } from './Task.js'
import {
  LlmProvider,
  LlmMessage,
  LlmContentBlock,
  LlmTool,
  LlmCompletionResponse,
  createLlmProvider,
  getDefaultProvider,
  type LlmProviderConfig,
} from './LlmProvider.js'

export type QuerySource = 'cli' | 'channel' | 'gateway' | 'plugin' | 'api' | 'scheduler'

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface BaseMessage {
  id: string
  role: MessageRole
  content: string | ContentBlock[]
  timestamp: number
  metadata?: Record<string, unknown>
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image' | 'thinking'
  text?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: unknown
  isError?: boolean
  toolUseId?: string
}

export interface UserMessage extends BaseMessage {
  role: 'user'
}

export interface AssistantMessage extends BaseMessage {
  role: 'assistant'
  apiError?: string
}

export interface SystemMessage extends BaseMessage {
  role: 'system'
}

export interface ToolResultMessage {
  id: string
  role: 'tool'
  content?: string | ContentBlock[]
  toolUseId: string
  toolName: string
  result: unknown
  isError?: boolean
  timestamp: number
  metadata?: Record<string, unknown>
}

export type Message = UserMessage | AssistantMessage | SystemMessage | ToolResultMessage

export type QueryParams = {
  messages: Message[]
  systemPrompt: string
  userContext: Record<string, string>
  systemContext: Record<string, string>
  canUseTool: (toolName: string, toolInput: Record<string, unknown>) => Promise<PermissionResult>
  toolUseContext: ToolUseContext
  querySource: QuerySource
  maxOutputTokens?: number
  maxTurns?: number
  taskBudget?: { total: number; remaining: number }
  model?: string
  temperature?: number
  abortController?: AbortController
}

export type QueryResult = {
  success: boolean
  response?: string
  messages: Message[]
  toolCalls: ToolCallRecord[]
  tokenUsage?: TokenUsage
  error?: Error
  status: 'completed' | 'error' | 'cancelled' | 'max_turns_reached'
}

export type ToolCallRecord = {
  id: string
  name: string
  input: Record<string, unknown>
  output?: unknown
  duration: number
  status: 'success' | 'error' | 'cancelled'
  timestamp: number
}

export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

type QueryConfig = {
  maxTurns: number
  maxOutputTokens: number
  enableCompact: boolean
  compactThreshold: number
  enableTokenBudget: boolean
  totalTokenBudget: number
}

const DEFAULT_QUERY_CONFIG: QueryConfig = {
  maxTurns: 50,
  maxOutputTokens: 16384,
  enableCompact: true,
  compactThreshold: 128000,
  enableTokenBudget: true,
  totalTokenBudget: 500000,
}

export class QueryEngine {
  private config: QueryConfig
  private tools: Tools
  private messageHistory: Message[] = []
  private turnCount = 0
  private tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  private llmProvider: LlmProvider
  private model: string

  constructor(tools: Tools, config?: Partial<QueryConfig> & { llmProvider?: LlmProvider; llmConfig?: LlmProviderConfig; model?: string }) {
    this.tools = tools
    this.config = { ...DEFAULT_QUERY_CONFIG, ...config }
    this.llmProvider = config?.llmProvider ?? getDefaultProvider()
    this.model = config?.model ?? this.llmProvider.config.defaultModel
  }

  setModel(model: string): void {
    this.model = model
  }

  setLlmProvider(provider: LlmProvider): void {
    this.llmProvider = provider
    if (!this.model) {
      this.model = provider.config.defaultModel
    }
  }

  async execute(params: QueryParams): Promise<QueryResult> {
    this.messageHistory = [...params.messages]
    this.turnCount = 0
    this.tokenUsage = { inputTokens: 0, outputTokens: 0 }

    const effectiveModel = params.model ?? this.model
    const effectiveTemperature = params.temperature ?? 0.7

    try {
      while (this.turnCount < this.config.maxTurns) {
        if (params.abortController?.signal.aborted) {
          return {
            success: false,
            messages: this.messageHistory,
            toolCalls: [],
            status: 'cancelled',
          }
        }

        const shouldCompact =
          this.config.enableCompact &&
          this.estimateTokenCount() > this.config.compactThreshold

        if (shouldCompact) {
          await this.performCompact()
        }

        const turnResult = await this.executeTurn(params, effectiveModel, effectiveTemperature)
        this.messageHistory.push(...turnResult.newMessages)

        if (turnResult.isComplete) {
          break
        }

        this.turnCount++
      }

      return {
        success: true,
        response: this.extractLastAssistantResponse(),
        messages: this.messageHistory,
        toolCalls: this.getToolCallRecords(),
        tokenUsage: this.tokenUsage,
        status:
          this.turnCount >= this.config.maxTurns
            ? 'max_turns_reached'
            : 'completed',
      }
    } catch (error) {
      return {
        success: false,
        messages: this.messageHistory,
        toolCalls: [],
        error: error as Error,
        status: 'error',
      }
    }
  }

  private async executeTurn(
    params: QueryParams,
    model: string,
    temperature: number,
  ): Promise<{ newMessages: Message[]; isComplete: boolean }> {
    const systemPrompt = await this.buildSystemPrompt(params)
    const requestMessages = this.prepareMessagesForAPI(systemPrompt)

    const response = await this.callLLM(requestMessages, params, model, temperature)
    this.updateTokenUsage(response.usage)

    const assistantMessage: AssistantMessage = {
      id: this.generateMessageId(),
      role: 'assistant',
      content: response.content,
      timestamp: Date.now(),
      ...(response.error ? { apiError: response.error.message } : {}),
    }

    const newMessages: Message[] = [assistantMessage]

    if (response.error) {
      return { newMessages, isComplete: true }
    }

    const toolUseBlocks = (Array.isArray(response.content) ? response.content : [{ type: 'text' as const, text: response.content }])
      .filter((block): block is ContentBlock & { type: 'tool_use'; toolName: string } =>
        block.type === 'tool_use' && typeof block.toolName === 'string',
      )

    if (toolUseBlocks.length === 0) {
      return { newMessages, isComplete: true }
    }

    const toolResults = await this.executeTools(toolUseBlocks, params)
    newMessages.push(...toolResults)

    return { newMessages, isComplete: false }
  }

  private async executeTools(
    toolUseBlocks: (ContentBlock & { type: 'tool_use' })[],
    params: QueryParams,
  ): Promise<ToolResultMessage[]> {
    const results: ToolResultMessage[] = []

    for (const toolUse of toolUseBlocks) {
      if (params.abortController?.signal.aborted) {
        break
      }

      const tool = findToolByName(this.tools, toolUse.toolName!)
      if (!tool) {
        results.push({
          id: this.generateMessageId(),
          role: 'tool',
          toolUseId: toolUse.toolUseId ?? `tool_${Date.now()}`,
          toolName: toolUse.toolName!,
          result: `Tool "${toolUse.toolName}" not found`,
          isError: true,
          timestamp: Date.now(),
        })
        continue
      }

      try {
        const permissionResult = await params.canUseTool(
          tool.name,
          toolUse.toolInput ?? {},
        )

        if (permissionResult.behavior !== 'allow') {
          results.push({
            id: this.generateMessageId(),
            role: 'tool',
            toolUseId: toolUse.toolUseId ?? `tool_${Date.now()}`,
            toolName: tool.name,
            result:
              permissionResult.behavior === 'deny'
                ? `Permission denied: ${permissionResult.message}`
                : 'Permission required - awaiting user approval',
            isError: permissionResult.behavior === 'deny',
            timestamp: Date.now(),
          })
          continue
        }

        const startTime = Date.now()
        const toolResult = await tool.call(
          toolUse.toolInput ?? {},
          params.toolUseContext,
          () => Promise.resolve(permissionResult),
          undefined,
        )
        const duration = Date.now() - startTime

        results.push({
          id: this.generateMessageId(),
          role: 'tool',
          toolUseId: toolUse.toolUseId ?? `tool_${Date.now()}`,
          toolName: tool.name,
          result: toolResult.data,
          timestamp: Date.now(),
        })

        if (toolResult.newMessages) {
          this.messageHistory.push(...(toolResult.newMessages as Message[]))
        }
      } catch (error) {
        results.push({
          id: this.generateMessageId(),
          role: 'tool',
          toolUseId: toolUse.toolUseId ?? `tool_${Date.now()}`,
          toolName: tool.name,
          result: `Error executing tool: ${(error as Error).message}`,
          isError: true,
          timestamp: Date.now(),
        })
      }
    }

    return results
  }

  private async buildSystemPrompt(params: QueryParams): Promise<string> {
    const sections: string[] = [params.systemPrompt]

    if (Object.keys(params.systemContext).length > 0) {
      sections.push(
        '\n## System Context\n' +
          Object.entries(params.systemContext)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n'),
      )
    }

    if (Object.keys(params.userContext).length > 0) {
      sections.push(
        '\n## User Context\n' +
          Object.entries(params.userContext)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n'),
      )
    }

    const toolDescriptions = await Promise.all(
      this.tools.map(async (tool) => {
        if (!tool.isEnabled()) return null
        try {
          const desc = await tool.description(
            {} as any,
            {
              toolPermissionContext: {
                mode: 'default',
                alwaysAllowRules: new Map(),
                alwaysDenyRules: new Map(),
                isBypassPermissionsModeAvailable: false,
              },
              tools: this.tools,
            },
          )
          return desc
        } catch {
          return null
        }
      }),
    )

    const validTools = toolDescriptions.filter((t): t is string => t !== null)
    if (validTools.length > 0) {
      sections.push('\n## Available Tools\n' + validTools.join('\n\n'))
    }

    return sections.join('\n')
  }

  private prepareMessagesForAPI(systemPrompt: string): LlmMessage[] {
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: systemPrompt,
      },
    ]

    for (const msg of this.messageHistory) {
      if (msg.role === 'system') continue

      let content: string | LlmContentBlock[]
      if (msg.role === 'tool') {
        const toolMsg = msg as ToolResultMessage
        if (toolMsg.content === undefined) {
          content = String(toolMsg.result ?? '')
        } else if (typeof toolMsg.content === 'string') {
          content = toolMsg.content
        } else {
          const blocks: LlmContentBlock[] = []
          for (const block of toolMsg.content) {
            if (block.type === 'thinking') continue
            if (block.type === 'text') {
              blocks.push({ type: 'text', text: block.text ?? '' })
            } else if (block.type === 'tool_result') {
              blocks.push({
                type: 'tool_result',
                content: String((block as any).toolResult ?? ''),
              })
            } else if (block.type === 'tool_use') {
              blocks.push({
                type: 'tool_use',
                id: (block as any).toolUseId ?? '',
                name: (block as any).toolName ?? '',
                input: (block as any).toolInput ?? {},
              })
            }
          }
          content = blocks
        }
      } else if (Array.isArray(msg.content)) {
        const blocks: LlmContentBlock[] = []
        for (const block of msg.content) {
          if (block.type === 'thinking') continue
          if (block.type === 'text') {
            blocks.push({ type: 'text', text: block.text ?? '' })
          } else if (block.type === 'tool_result') {
            blocks.push({
              type: 'tool_result',
              content: String((block as any).toolResult ?? ''),
            })
          } else if (block.type === 'tool_use') {
            blocks.push({
              type: 'tool_use',
              id: (block as any).toolUseId ?? '',
              name: (block as any).toolName ?? '',
              input: (block as any).toolInput ?? {},
            })
          }
        }
        content = blocks
      } else {
        content = msg.content ?? ''
      }

      messages.push({
        role: msg.role === 'tool' ? 'tool' : msg.role,
        content,
        name: msg.metadata?.name as string | undefined,
      })
    }

    return messages
  }

  private async callLLM(
    messages: LlmMessage[],
    params: QueryParams,
    model: string,
    temperature: number,
  ): Promise<{ content: ContentBlock[]; usage: TokenUsage; error?: { message: string } }> {
    try {
      const tools: LlmTool[] = []
      for (const t of this.tools) {
        if (t.isEnabled()) {
          try {
            const desc = await t.description(
              {} as any,
              {
                toolPermissionContext: {
                  mode: 'default',
                  alwaysAllowRules: new Map(),
                  alwaysDenyRules: new Map(),
                  isBypassPermissionsModeAvailable: false,
                },
                tools: this.tools,
              },
            )
            tools.push({
              name: t.name,
              description: desc,
              input_schema: { type: 'object' as const },
            })
          } catch {
            // Skip tools that fail to provide description
          }
        }
      }

      const response = await this.llmProvider.complete({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        temperature,
        maxTokens: params.maxOutputTokens ?? this.config.maxOutputTokens,
      })

      if (response.error) {
        return {
          content: [{ type: 'text', text: `API Error: ${response.error.message}` }],
          usage: response.usage ?? { inputTokens: 0, outputTokens: 0 },
          error: response.error,
        }
      }

      const choice = response.choices[0]
      if (!choice) {
        return {
          content: [{ type: 'text', text: 'No response from model' }],
          usage: response.usage ?? { inputTokens: 0, outputTokens: 0 },
        }
      }

      const content: ContentBlock[] = []

      const messageContent = choice.message.content
      if (typeof messageContent === 'string') {
        content.push({ type: 'text', text: messageContent })
      } else if (Array.isArray(messageContent)) {
        for (const block of messageContent) {
          if (block.type === 'text' && block.text) {
            content.push({ type: 'text', text: block.text })
          } else if (block.type === 'tool_use') {
            content.push({
              type: 'tool_use',
              toolName: block.name ?? block.function?.name ?? '',
              toolInput: block.input ?? (block.function ? JSON.parse(block.function.arguments ?? '{}') : {}),
              toolUseId: block.id ?? block.toolCallId ?? '',
            })
          } else if (block.type === 'tool_result') {
            content.push({
              type: 'tool_result',
              toolResult: block.content,
              toolUseId: block.id,
            })
          }
        }
      }

      if (choice.message.toolCalls) {
        for (const tc of choice.message.toolCalls) {
          content.push({
            type: 'tool_use',
            toolName: tc.function.name,
            toolInput: JSON.parse(tc.function.arguments),
            toolUseId: tc.id,
          })
        }
      }

      return {
        content,
        usage: response.usage ?? { inputTokens: 0, outputTokens: 0 },
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `LLM Error: ${(error as Error).message}` }],
        usage: { inputTokens: 0, outputTokens: 0 },
        error: { message: (error as Error).message },
      }
    }
  }

  private async performCompact(): Promise<void> {
    console.log('[QueryEngine] Performing context compaction')
    const oldMessages = this.messageHistory.filter(m => m.role !== 'system')
    if (oldMessages.length < 10) return

    const summaryMessage: UserMessage = {
      id: this.generateMessageId(),
      role: 'user',
      content: `[Previous conversation summarized: ${oldMessages.length} messages about various topics]`,
      timestamp: Date.now(),
    }

    this.messageHistory = [summaryMessage]
  }

  private estimateTokenCount(): number {
    return Math.round(JSON.stringify(this.messageHistory).length / 4)
  }

  private updateTokenUsage(usage: TokenUsage): void {
    this.tokenUsage.inputTokens += usage.inputTokens ?? 0
    this.tokenUsage.outputTokens += usage.outputTokens ?? 0
  }

  private extractLastAssistantResponse(): string {
    for (let i = this.messageHistory.length - 1; i >= 0; i--) {
      const msg = this.messageHistory[i]!
      if (msg.role === 'assistant') {
        const textBlocks = Array.isArray(msg.content)
          ? msg.content.filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
          : []
        return textBlocks.map(b => b.text).join(' ') ?? ''
      }
    }
    return ''
  }

  private getToolCallRecords(): ToolCallRecord[] {
    return this.messageHistory
      .filter((m): m is ToolResultMessage => m.role === 'tool')
      .map(m => ({
        id: m.toolUseId,
        name: m.toolName,
        input: {},
        output: m.result,
        duration: 0,
        status: m.isError ? 'error' : ('success' as const),
        timestamp: m.timestamp,
      }))
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }
}

function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(t => t.name === name || t.aliases?.includes(name))
}

export { createLlmProvider, getDefaultProvider }
export type { LlmProvider, LlmProviderConfig, LlmModelInfo } from './LlmProvider.js'
