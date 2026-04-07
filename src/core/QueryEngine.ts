import type { Tool, Tools, ToolUseContext, PermissionResult } from './Tool.js'
import type { TaskType, TaskStatus, TaskStateBase, TaskPriority, generateTaskId, createTaskStateBase } from './Task.js'
import { isTerminalTaskStatus } from './Task.js'

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

export interface ToolResultMessage extends BaseMessage {
  role: 'tool'
  toolUseId: string
  toolName: string
  result: unknown
  isError?: boolean
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

  constructor(tools: Tools, config?: Partial<QueryConfig>) {
    this.tools = tools
    this.config = { ...DEFAULT_QUERY_CONFIG, ...config }
  }

  async execute(params: QueryParams): Promise<QueryResult> {
    this.messageHistory = [...params.messages]
    this.turnCount = 0
    this.tokenUsage = { inputTokens: 0, outputTokens: 0 }

    try {
      while (this.turnCount < this.config.maxTurns) {
        if (params.abortController.signal.aborted) {
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

        const turnResult = await this.executeTurn(params)
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
  ): Promise<{ newMessages: Message[]; isComplete: boolean }> {
    const systemPrompt = await this.buildSystemPrompt(params)
    const requestMessages = this.prepareMessagesForAPI(systemPrompt)

    const response = await this.callLLM(requestMessages, params)
    this.updateTokenUsage(response.usage)

    const assistantMessage: AssistantMessage = {
      id: this.generateMessageId(),
      role: 'assistant',
      content: response.content,
      timestamp: Date.now(),
    }

    const newMessages: Message[] = [assistantMessage]

    const toolUseBlocks = response.content.filter(
      (block): block is ContentBlock & { type: 'tool_use' } =>
        block.type === 'tool_use',
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
      if (params.abortController.signal.aborted) {
        break
      }

      const tool = findToolByName(this.tools, toolUse.toolName!)
      if (!tool) {
        results.push({
          id: this.generateMessageId(),
          role: 'tool',
          toolUseId: toolUse.toolUseId!,
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
            toolUseId: toolUse.toolUseId!,
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
          assistantMessage,
        )
        const duration = Date.now() - startTime

        results.push({
          id: this.generateMessageId(),
          role: 'tool',
          toolUseId: toolUse.toolUseId!,
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
          toolUseId: toolUse.toolUseId!,
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
        const desc = await tool.description(
          {} as any,
          {
            toolPermissionContext: params.toolUseContext.options.tools
              ? { mode: 'default', alwaysAllowRules: new Map(), alwaysDenyRules: new Map(), isBypassPermissionsModeAvailable: false }
              : { mode: 'default', alwaysAllowRules: new Map(), alwaysDenyRules: new Map(), isBypassPermissionsModeAvailable: false },
            tools: this.tools,
          },
        )
        return desc
      }),
    )

    const validTools = toolDescriptions.filter((t): t is string => t !== null)
    if (validTools.length > 0) {
      sections.push('\n## Available Tools\n' + validTools.join('\n\n'))
    }

    return sections.join('\n')
  }

  private prepareMessagesForAPI(systemPrompt: string): Message[] {
    return [
      {
        id: this.generateMessageId(),
        role: 'system',
        content: systemPrompt,
        timestamp: Date.now(),
      },
      ...this.messageHistory,
    ]
  }

  private async callLLM(
    messages: Message[],
    _params: QueryParams,
  ): Promise<{ content: ContentBlock[]; usage: TokenUsage }> {
    // This would be replaced with actual LLM API integration
    // For now, return a mock response
    return {
      content: [{ type: 'text', text: 'Response from query engine' }],
      usage: { inputTokens: 100, outputTokens: 50 },
    }
  }

  private async performCompact(): Promise<void> {
    // Implement context compaction algorithm from claude-code
    // This would summarize older messages to reduce token count
    console.log('[QueryEngine] Performing context compaction')
  }

  private estimateTokenCount(): number {
    // Rough estimation based on message length
    return Math.round(JSON.stringify(this.messageHistory).length / 4)
  }

  private updateTokenUsage(usage: Partial<TokenUsage>): void {
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
