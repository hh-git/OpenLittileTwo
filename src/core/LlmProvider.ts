export type LlmProviderType = 'openai' | 'anthropic' | 'azure' | 'google' | 'cohere' | 'local' | 'custom'

export interface LlmProviderConfig {
  type: LlmProviderType
  baseURL?: string
  apiKey?: string
  apiVersion?: string
  organization?: string
  defaultModel?: string
  maxRetries?: number
  timeout?: number
}

export interface LlmModelInfo {
  id: string
  name: string
  provider: LlmProviderType
  contextWindow: number
  maxOutputTokens?: number
  supportsStreaming?: boolean
  supportsTools?: boolean
  inputCostPerToken?: number
  outputCostPerToken?: number
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | LlmContentBlock[]
  name?: string
  toolCalls?: LlmToolCall[]
  toolCallId?: string
}

export interface LlmContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result'
  text?: string
  source?: {
    type: 'base64' | 'url'
    media_type: string
    data: string
  }
  id?: string
  name?: string
  input?: Record<string, unknown>
  content?: string
  function?: {
    name?: string
    arguments?: string
  }
  toolCallId?: string
}

export interface LlmToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface LlmTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface LlmCompletionParams {
  model: string
  messages: LlmMessage[]
  tools?: LlmTool[]
  temperature?: number
  topP?: number
  maxTokens?: number
  stop?: string[]
  stream?: boolean
  reasoningEffort?: number
}

export interface LlmCompletionResponse {
  id: string
  model: string
  choices: LlmChoice[]
  usage?: LlmUsage
  error?: LlmError
}

export interface LlmChoice {
  message: LlmAssistantMessage
  finishReason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'function_call'
  index: number
}

export interface LlmAssistantMessage {
  role: 'assistant'
  content: string | LlmContentBlock[]
  toolCalls?: LlmToolCall[]
}

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

export interface LlmError {
  code: string
  message: string
  param?: string
  type: string
}

export interface LlmStreamChunk {
  id: string
  choices: LlmStreamChoice[]
  usage?: LlmUsage
}

export interface LlmStreamChoice {
  delta: Partial<LlmAssistantMessage>
  finishReason?: string
  index: number
}

export abstract class LlmProvider {
  readonly type: LlmProviderType
  readonly config: Required<LlmProviderConfig>
  abstract readonly supportedModels: LlmModelInfo[]

  constructor(config: LlmProviderConfig) {
    this.type = config.type
    this.config = {
      type: config.type,
      baseURL: config.baseURL ?? this.getDefaultBaseURL(),
      apiKey: config.apiKey ?? '',
      apiVersion: config.apiVersion ?? 'v1',
      organization: config.organization ?? '',
      defaultModel: config.defaultModel ?? this.getDefaultModel(),
      maxRetries: config.maxRetries ?? 3,
      timeout: config.timeout ?? 60000,
    }
  }

  abstract getDefaultBaseURL(): string
  abstract getDefaultModel(): string

  abstract complete(params: LlmCompletionParams): Promise<LlmCompletionResponse>
  abstract streamComplete(params: LlmCompletionParams): AsyncGenerator<LlmStreamChunk, void, unknown>

  protected abstract buildRequest(params: LlmCompletionParams): RequestInit
  protected abstract parseResponse(response: unknown): LlmCompletionResponse

  protected async fetchWithRetry(
    url: string,
    options: RequestInit,
    retries = this.config.maxRetries
  ): Promise<Response> {
    let lastError: Error | undefined

    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, {
          ...options,
          signal: AbortSignal.timeout(this.config.timeout),
        })

        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After')
          const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.pow(2, i) * 1000
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }

        return response
      } catch (error) {
        lastError = error as Error
        if (i < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000))
        }
      }
    }

    throw lastError ?? new Error('Max retries exceeded')
  }
}

export class OpenAIProvider extends LlmProvider {
  readonly type: LlmProviderType = 'openai'
  readonly supportedModels: LlmModelInfo[] = [
    { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', contextWindow: 128000, supportsStreaming: true, supportsTools: true, inputCostPerToken: 0.005, outputCostPerToken: 0.015 },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', contextWindow: 128000, supportsStreaming: true, supportsTools: true, inputCostPerToken: 0.00015, outputCostPerToken: 0.0006 },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', provider: 'openai', contextWindow: 128000, supportsStreaming: true, supportsTools: true, inputCostPerToken: 0.01, outputCostPerToken: 0.03 },
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', provider: 'openai', contextWindow: 16385, supportsStreaming: true, supportsTools: true, inputCostPerToken: 0.0005, outputCostPerToken: 0.0015 },
  ]

  getDefaultBaseURL(): string {
    return 'https://api.openai.com'
  }

  getDefaultModel(): string {
    return 'gpt-4o-mini'
  }

  complete(params: LlmCompletionParams): Promise<LlmCompletionResponse> {
    const url = `${this.config.baseURL}/v1/chat/completions`
    const request = this.buildRequest(params)

    return this.fetchWithRetry(url, request).then(async response => {
      if (!response.ok) {
        const errorData = await response.json() as { error?: { message?: string; type?: string } }
        return {
          id: '',
          model: params.model,
          choices: [],
          error: { code: String(response.status), message: errorData.error?.message ?? 'Unknown error', type: errorData.error?.type ?? 'api_error' },
        }
      }

      const data = await response.json()
      return this.parseResponse(data)
    })
  }

  async *streamComplete(params: LlmCompletionParams): AsyncGenerator<LlmStreamChunk, void, unknown> {
    const url = `${this.config.baseURL}/v1/chat/completions`
    const request = this.buildRequest({ ...params, stream: true })

    const response = await this.fetchWithRetry(url, request)

    if (!response.ok || !response.body) {
      const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(errorData.error?.message ?? `HTTP ${response.status}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') return
            try {
              yield JSON.parse(data) as LlmStreamChunk
            } catch {}
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  protected buildRequest(params: LlmCompletionParams): RequestInit {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages.map(msg => ({
        role: msg.role,
        content: msg.content,
        ...(msg.name ? { name: msg.name } : {}),
        ...(msg.toolCalls ? { tool_calls: msg.toolCalls } : {}),
        ...(msg.toolCallId ? { tool_call_id: msg.toolCallId } : {}),
      })),
      ...(params.tools?.length ? { tools: params.tools } : {}),
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.topP !== undefined ? { top_p: params.topP } : {}),
      ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
      ...(params.stop ? { stop: params.stop } : {}),
      ...(params.stream ? { stream: true } : {}),
    }

    return {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
        ...(this.config.organization ? { 'OpenAI-Organization': this.config.organization } : {}),
      },
      body: JSON.stringify(body),
    }
  }

  protected parseResponse(data: unknown): LlmCompletionResponse {
    const d = data as {
      id: string
      model: string
      choices: Array<{
        message: { role: string; content: string | null; tool_calls?: LlmToolCall[] }
        finish_reason: string
        index: number
      }>
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_tokens?: number }
    }

    return {
      id: d.id,
      model: d.model,
      choices: d.choices.map(choice => ({
        message: {
          role: 'assistant',
          content: choice.message.content ?? '',
          ...(choice.message.tool_calls ? { toolCalls: choice.message.tool_calls } : {}),
        },
        finishReason: choice.finish_reason as LlmChoice['finishReason'],
        index: choice.index,
      })),
      usage: d.usage ? {
        inputTokens: d.usage.prompt_tokens,
        outputTokens: d.usage.completion_tokens,
        cacheReadInputTokens: d.usage.cached_tokens,
      } : undefined,
    }
  }
}

export class AnthropicProvider extends LlmProvider {
  readonly type: LlmProviderType = 'anthropic'
  readonly supportedModels: LlmModelInfo[] = [
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', contextWindow: 200000, supportsStreaming: true, supportsTools: true, inputCostPerToken: 0.003, outputCostPerToken: 0.015 },
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', provider: 'anthropic', contextWindow: 200000, supportsStreaming: true, supportsTools: true, inputCostPerToken: 0.003, outputCostPerToken: 0.015 },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', provider: 'anthropic', contextWindow: 200000, supportsStreaming: true, supportsTools: true, inputCostPerToken: 0.0008, outputCostPerToken: 0.004 },
    { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', provider: 'anthropic', contextWindow: 200000, supportsStreaming: true, supportsTools: true, inputCostPerToken: 0.015, outputCostPerToken: 0.075 },
  ]

  getDefaultBaseURL(): string {
    return 'https://api.anthropic.com'
  }

  getDefaultModel(): string {
    return 'claude-sonnet-4-20250514'
  }

  complete(params: LlmCompletionParams): Promise<LlmCompletionResponse> {
    const url = `${this.config.baseURL}/v1/messages`
    const request = this.buildRequest(params)

    return this.fetchWithRetry(url, request).then(async response => {
      if (!response.ok) {
        const errorData = await response.json() as { error?: { message?: string; type?: string } }
        return {
          id: '',
          model: params.model,
          choices: [],
          error: { code: String(response.status), message: errorData.error?.message ?? 'Unknown error', type: errorData.error?.type ?? 'api_error' },
        }
      }

      const data = await response.json()
      return this.parseResponse(data)
    })
  }

  async *streamComplete(params: LlmCompletionParams): AsyncGenerator<LlmStreamChunk, void, unknown> {
    const url = `${this.config.baseURL}/v1/messages`
    const request = this.buildRequest({ ...params, stream: true })

    const response = await this.fetchWithRetry(url, request)

    if (!response.ok || !response.body) {
      const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(errorData.error?.message ?? `HTTP ${response.status}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') return
            try {
              const parsed = this.parseStreamChunk(JSON.parse(data))
              if (parsed) yield parsed
            } catch {}
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private parseStreamChunk(data: unknown): LlmStreamChunk | null {
    const d = data as { type: string; index?: number; delta?: { text?: string; type?: string }; usage?: { input_tokens: number; output_tokens: number } }
    if (d.type === 'message_delta' && d.usage) {
      return {
        id: '',
        choices: [],
        usage: { inputTokens: 0, outputTokens: d.usage.output_tokens },
      }
    }
    if (d.type === 'content_block_delta' && d.delta?.text) {
      return {
        id: '',
        choices: [{
          delta: { content: d.delta.text },
          index: d.index ?? 0,
        }],
      }
    }
    return null
  }

  protected buildRequest(params: LlmCompletionParams): RequestInit {
    const systemMessage = params.messages.find(m => m.role === 'system')
    const otherMessages = params.messages.filter(m => m.role !== 'system')

    const body: Record<string, unknown> = {
      model: params.model,
      messages: otherMessages.map(msg => ({
        role: msg.role === 'tool' ? 'user' : msg.role,
        content: msg.content,
      })),
      ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : { max_tokens: 4096 }),
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(systemMessage ? { system: systemMessage.content } : {}),
      ...(params.stream ? { stream: true } : {}),
    }

    return {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    }
  }

  protected parseResponse(data: unknown): LlmCompletionResponse {
    const d = data as {
      id: string
      model: string
      content: Array<{ type: string; text?: string; tool_use?: LlmToolCall }>
      stop_reason: string
      usage: { input_tokens: number; output_tokens: number }
    }

    return {
      id: d.id,
      model: d.model,
      choices: [{
        message: {
          role: 'assistant',
          content: d.content.map(c => c.text ?? '').join(''),
          ...(d.content.some(c => c.tool_use) ? {
            toolCalls: d.content.filter(c => c.tool_use).map(c => c.tool_use!)
          } : {}),
        },
        finishReason: d.stop_reason as LlmChoice['finishReason'],
        index: 0,
      }],
      usage: {
        inputTokens: d.usage.input_tokens,
        outputTokens: d.usage.output_tokens,
      },
    }
  }
}

export class AzureOpenAIProvider extends LlmProvider {
  readonly type: LlmProviderType = 'azure'
  readonly supportedModels: LlmModelInfo[] = []

  getDefaultBaseURL(): string {
    return ''
  }

  getDefaultModel(): string {
    return ''
  }

  complete(params: LlmCompletionParams): Promise<LlmCompletionResponse> {
    const deployment = params.model
    const url = `${this.config.baseURL}/openai/deployments/${deployment}/chat/completions?api-version=${this.config.apiVersion}`
    const request = this.buildRequest(params)

    return this.fetchWithRetry(url, request).then(async response => {
      if (!response.ok) {
        const errorData = await response.json() as { error?: { message?: string } }
        return {
          id: '',
          model: params.model,
          choices: [],
          error: { code: String(response.status), message: errorData.error?.message ?? 'Unknown error', type: 'api_error' },
        }
      }

      const data = await response.json()
      return this.parseOpenAIResponse(data)
    })
  }

  async *streamComplete(params: LlmCompletionParams): AsyncGenerator<LlmStreamChunk, void, unknown> {
    const openaiProvider = new OpenAIProvider({ type: 'openai', baseURL: '' })
    yield* openaiProvider.streamComplete(params)
  }

  protected buildRequest(params: LlmCompletionParams): RequestInit {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
      ...(params.stream ? { stream: true } : {}),
    }

    return {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': this.config.apiKey,
      },
      body: JSON.stringify(body),
    }
  }

  protected parseResponse(data: unknown): LlmCompletionResponse {
    return this.parseOpenAIResponse(data)
  }

  protected parseOpenAIResponse(data: unknown): LlmCompletionResponse {
    const d = data as {
      id: string
      model: string
      choices: Array<{
        message: { role: string; content: string | null; tool_calls?: LlmToolCall[] }
        finish_reason: string
        index: number
      }>
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_tokens?: number }
    }

    return {
      id: d.id,
      model: d.model,
      choices: d.choices.map(choice => ({
        message: {
          role: 'assistant' as const,
          content: choice.message.content ?? '',
          ...(choice.message.tool_calls ? { toolCalls: choice.message.tool_calls } : {}),
        },
        finishReason: choice.finish_reason as LlmChoice['finishReason'],
        index: choice.index,
      })),
      usage: d.usage ? {
        inputTokens: d.usage.prompt_tokens,
        outputTokens: d.usage.completion_tokens,
        cacheReadInputTokens: d.usage.cached_tokens,
      } : undefined,
    }
  }
}

export function createLlmProvider(config: LlmProviderConfig): LlmProvider {
  switch (config.type) {
    case 'openai':
      return new OpenAIProvider(config)
    case 'anthropic':
      return new AnthropicProvider(config)
    case 'azure':
      return new AzureOpenAIProvider(config)
    case 'local':
    case 'custom':
      return new OpenAIProvider({ ...config, baseURL: config.baseURL ?? 'http://localhost:8080/v1' })
    default:
      return new OpenAIProvider(config)
  }
}

export function getDefaultProvider(): LlmProvider {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? ''

  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider({
      type: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      defaultModel: 'claude-sonnet-4-20250514',
    })
  }

  if (process.env.OPENAI_API_KEY) {
    return new OpenAIProvider({
      type: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      defaultModel: 'gpt-4o-mini',
    })
  }

  if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT) {
    return new AzureOpenAIProvider({
      type: 'azure',
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      baseURL: process.env.AZURE_OPENAI_ENDPOINT,
      apiVersion: '2024-02-01',
    })
  }

  return new OpenAIProvider({
    type: 'openai',
    apiKey: '',
    baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
    defaultModel: 'gpt-4o-mini',
  })
}
