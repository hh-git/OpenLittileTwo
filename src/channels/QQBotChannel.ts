import { WebSocket } from 'ws'
import { BaseChannel, type ChannelConfig, type ChannelMessage, type ChannelEvent } from './BaseChannel.js'

export type QQBotChannelType = 'qqbot'

export interface QQBotAccount {
  appId: string
  clientSecret: string
  enabled?: boolean
}

export interface QQBotChannelConfig extends Omit<ChannelConfig, 'type'> {
  type: QQBotChannelType
  appId: string
  clientSecret: string
  accounts?: Record<string, QQBotAccount>
  stt?: {
    provider?: string
    model?: string
  }
  tts?: {
    provider?: string
    model?: string
    voice?: string
  }
}

export interface QQBotMessage {
  msg_id: string
  msg_type: number
  content: string
  from_user_id: string
  from_user_nickname?: string
  guild_id?: string
  channel_id?: string
  group_openid?: string
  c2c_openid?: string
  timestamp: number
  subtype?: string
}

export interface QQBotOutboundMessage {
  content: string
  msg_type?: number
  guild_id?: string
  channel_id?: string
  group_openid?: string
  c2c_openid?: string
}

interface QQBotAPIError {
  code: number
  message: string
}

const QQ_BOT_API_BASE = 'https://api.sgroup.qq.com'

const QQ_MSG_TYPE = {
  TEXT: 0,
  IMAGE: 1,
  VIDEO: 2,
  AUDIO: 3,
  FILE: 4,
} as const

const QQ_BOT_INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  CHANNEL_MESSAGES: 1 << 9,
  INTERACTION: 1 << 26,
  GROUP_MESSAGES: 1 << 29,
} as const

const REQUIRED_INTENTS =
  QQ_BOT_INTENTS.CHANNEL_MESSAGES |
  QQ_BOT_INTENTS.GROUP_MESSAGES |
  QQ_BOT_INTENTS.INTERACTION

export class QQBotChannel extends BaseChannel {
  readonly type: QQBotChannelType = 'qqbot'
  readonly name: string
  private ws: WebSocket | null = null
  private tokenCache: Map<string, { token: string; expiresAt: number }> = new Map()
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelayMs = 1000
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private messageHandlers: Map<string, (message: ChannelMessage) => Promise<void>> = new Map()
  private currentAccountId: string = 'default'
  private accessToken: string | null = null

  constructor(config: QQBotChannelConfig) {
    super({
      ...config,
      type: 'qqbot',
      name: config.name || `qqbot-${config.id}`,
    } as ChannelConfig)
    this.name = config.name || `qqbot-${config.id}`
  }

  async connect(): Promise<void> {
    if (this.status === 'connected') {
      return
    }

    this.setStatus('connecting')

    try {
      const token = await this.getAccessToken()
      await this.connectWebSocket(token)
      this.startHeartbeat()
      this.setStatus('connected')
      this.reconnectAttempts = 0
    } catch (error) {
      this.setStatus('error')
      throw error
    }
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat()
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect')
      this.ws = null
    }
    this.setStatus('disconnected')
  }

  async sendMessage(targetId: string, content: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected')
    }

    const parsed = this.parseTarget(targetId)
    const outbound: QQBotOutboundMessage = {
      content,
      ...parsed,
    }

    this.sendPayload('send_message', outbound as unknown as Record<string, unknown>)
  }

  async handleMessage(message: ChannelMessage): Promise<void> {
    this.emit({
      type: 'message',
      channelId: this.config.id,
      data: message,
      timestamp: Date.now(),
    })
  }

  onMessage(handler: (message: ChannelMessage) => Promise<void>): () => void {
    const id = `handler_${Date.now()}`
    this.messageHandlers.set(id, handler)
    return () => {
      this.messageHandlers.delete(id)
    }
  }

  private async getAccessToken(): Promise<string> {
    const cached = this.tokenCache.get(this.currentAccountId)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token
    }

    const config = this.getAccountConfig()
    if (!config) {
      throw new Error(`No configuration found for account: ${this.currentAccountId}`)
    }

    const response = await fetch(`${QQ_BOT_API_BASE}/app/login/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app_id: parseInt(config.appId, 10),
        client_secret: config.clientSecret,
        grant_type: 'client_credentials',
      }),
    })

    if (!response.ok) {
      const error = await response.json() as QQBotAPIError
      throw new Error(`Failed to get access token: ${error.message} (code: ${error.code})`)
    }

    const data = await response.json() as { access_token: string; expires_in: number }
    const expiresAt = Date.now() + (data.expires_in - 60) * 1000
    this.tokenCache.set(this.currentAccountId, { token: data.access_token, expiresAt })
    this.accessToken = data.access_token

    return data.access_token
  }

  private async connectWebSocket(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const dispatches = [
        'READY',
        'RESUMED',
        'GUILD_CREATE',
        'CHANNEL_CREATE',
        'MESSAGE_CREATE',
        'GROUP_MESSAGE_CREATE',
        'C2C_MESSAGE_CREATE',
        'INTERACTION_CREATE',
      ]

      const wsUrl = `wss://api.sgroup.qq.comgateway/?v=10&encoding=json&compress=gzip&access_token=${token}`

      this.ws = new WebSocket(wsUrl)

      this.ws.on('open', () => {
        console.log(`[QQBot:${this.name}] WebSocket connected`)
      })

      this.ws.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString())
          await this.handleWSMessage(message)
        } catch (error) {
          console.error(`[QQBot:${this.name}] Failed to parse message:`, error)
        }
      })

      this.ws.on('error', (error) => {
        console.error(`[QQBot:${this.name}] WebSocket error:`, error)
        if (this.status !== 'connected') {
          reject(error)
        }
      })

      this.ws.on('close', (code, reason) => {
        console.log(`[QQBot:${this.name}] WebSocket closed: ${code} - ${reason}`)
        this.handleDisconnect()
      })

      this.ws.on('pong', () => {
        console.log(`[QQBot:${this.name}] Heartbeat received`)
      })

      const connectTimeout = setTimeout(() => {
        if (this.status !== 'connected') {
          reject(new Error('Connection timeout'))
        }
      }, 30000)

      const handler = (event: ChannelEvent) => {
        if (event.type === 'connected') {
          clearTimeout(connectTimeout)
          this.off('connected', handler)
          resolve()
        }
      }

      this.once('connected', handler)
    })
  }

  private async handleWSMessage(message: Record<string, unknown>): Promise<void> {
    const op = message.op as number
    const t = message.t as string
    const d = message.d as Record<string, unknown> | undefined

    switch (op) {
      case 0:
        if (t === 'READY' || t === 'RESUMED') {
          console.log(`[QQBot:${this.name}] Received ${t}`)
          this.emit({
            type: 'connected',
            channelId: this.config.id,
            timestamp: Date.now(),
          })
        } else if (t === 'MESSAGE_CREATE' || t === 'GROUP_MESSAGE_CREATE' || t === 'C2C_MESSAGE_CREATE') {
          await this.handleIncomingMessage(d)
        }
        break
      case 1:
        console.log(`[QQBot:${this.name}] Heartbeat ack received`)
        break
      case 7:
        console.log(`[QQBot:${this.name}] Reconnecting due to opcode 7`)
        await this.reconnect()
        break
      case 11:
        console.log(`[QQBot:${this.name}] Heartbeat acknowledged`)
        break
      default:
        if (t) {
          console.log(`[QQBot:${this.name}] Unhandled event: ${t} (op: ${op})`)
        }
    }
  }

  private async handleIncomingMessage(data: Record<string, unknown> | undefined): Promise<void> {
    if (!data) return

    const channelMessage: ChannelMessage = {
      id: data.msg_id as string || `msg_${Date.now()}`,
      channelId: this.resolveChannelId(data),
      userId: this.resolveUserId(data),
      content: this.extractContent(data),
      timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
      metadata: {
        msgType: data.msg_type,
        subType: data.sub_type,
        guildId: data.guild_id,
        groupOpenid: data.group_openid,
        c2cOpenid: data.c2c_openid,
        fromUserNickname: data.nickname || data.username,
      },
    }

    for (const handler of this.messageHandlers.values()) {
      try {
        await handler(channelMessage)
      } catch (error) {
        console.error(`[QQBot:${this.name}] Message handler error:`, error)
      }
    }

    this.emit({
      type: 'message',
      channelId: this.config.id,
      data: channelMessage,
      timestamp: Date.now(),
    })
  }

  private resolveChannelId(data: Record<string, unknown>): string {
    if (data.channel_id) return `qqbot:channel:${data.channel_id}`
    if (data.group_openid) return `qqbot:group:${data.group_openid}`
    if (data.c2c_openid) return `qqbot:c2c:${data.c2c_openid}`
    return this.config.id
  }

  private resolveUserId(data: Record<string, unknown>): string {
    return String(data.user_id || data.openid || 'unknown')
  }

  private extractContent(data: Record<string, unknown>): string {
    if (typeof data.content === 'string') return data.content
    if (typeof data.text === 'string') return data.text
    if (data.app_id) return `[Media message: ${data.msg_type}]`
    return '[Empty message]'
  }

  private sendPayload(op: string, data: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected')
    }

    const payload = {
      op: 2,
      d: {
        ...data,
        access_token: this.accessToken,
      },
      t: op,
    }

    this.ws.send(JSON.stringify(payload))
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping()
        this.sendPayload('HEARTBEAT', { op: 1, d: null })
      }
    }, 30000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private handleDisconnect(): void {
    this.stopHeartbeat()
    this.setStatus('disconnected')

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1)
      console.log(`[QQBot:${this.name}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)
      setTimeout(() => this.reconnect(), delay)
    } else {
      console.error(`[QQBot:${this.name}] Max reconnect attempts reached`)
      this.setStatus('error')
    }
  }

  private async reconnect(): Promise<void> {
    try {
      this.setStatus('connecting')
      const token = await this.getAccessToken()
      await this.connectWebSocket(token)
      this.startHeartbeat()
      this.setStatus('connected')
      this.reconnectAttempts = 0
    } catch (error) {
      console.error(`[QQBot:${this.name}] Reconnect failed:`, error)
      this.handleDisconnect()
    }
  }

  private getAccountConfig(): QQBotAccount | null {
    const config = this.config as QQBotChannelConfig
    if (config.accounts && config.accounts[this.currentAccountId]) {
      return config.accounts[this.currentAccountId]
    }
    if (config.appId && config.clientSecret) {
      return { appId: config.appId, clientSecret: config.clientSecret }
    }
    return null
  }

  private parseTarget(targetId: string): Partial<QQBotOutboundMessage> {
    const parts = targetId.split(':')
    if (parts.length < 2) {
      return { content: targetId }
    }

    const [, type, id] = parts
    switch (type) {
      case 'c2c':
        return { c2c_openid: id }
      case 'group':
        return { group_openid: id }
      case 'channel':
        return { channel_id: id, guild_id: parts[3] }
      default:
        return { content: targetId }
    }
  }

  setAccount(accountId: string): void {
    this.currentAccountId = accountId
    this.tokenCache.delete(accountId)
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }
}

export function createQQBotChannel(config: QQBotChannelConfig): QQBotChannel {
  return new QQBotChannel(config)
}

export function parseQQBotToken(token: string): { appId: string; clientSecret: string } {
  const parts = token.split(':')
  if (parts.length !== 2) {
    throw new Error('Invalid QQ Bot token format. Expected: AppID:AppSecret')
  }
  return { appId: parts[0], clientSecret: parts[1] }
}
