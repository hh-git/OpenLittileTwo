import { EventEmitter } from 'events'
import type { ToolUseContext, PermissionResult } from '../core/Tool.js'
import type { TaskType, TaskStatus } from '../core/Task.js'

export interface ChannelMessage {
  id: string
  channelId: string
  userId: string
  content: string
  timestamp: number
  metadata?: Record<string, unknown>
}

export interface ChannelConfig {
  id: string
  name: string
  type: ChannelType
  enabled: boolean
  credentials?: Record<string, string>
  options?: Record<string, unknown>
}

export type ChannelType =
  | 'irc'
  | 'slack'
  | 'telegram'
  | 'discord'
  | 'matrix'
  | 'line'
  | 'whatsapp'
  | 'webchat'
  | 'webhook'
  | 'qqbot'
  | 'custom'

export type ChannelStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

export interface ChannelEvent {
  type: 'message' | 'connected' | 'disconnected' | 'error' | 'typing'
  channelId: string
  data?: unknown
  timestamp: number
}

export abstract class BaseChannel {
  abstract readonly type: ChannelType
  abstract readonly name: string

  protected config: ChannelConfig
  protected status: ChannelStatus = 'disconnected'
  private emitter = new EventEmitter()

  constructor(config: ChannelConfig) {
    this.config = config
  }

  abstract connect(): Promise<void>
  abstract disconnect(): Promise<void>
  abstract sendMessage(userId: string, content: string): Promise<void>
  abstract handleMessage(message: ChannelMessage): Promise<void>

  getStatus(): ChannelStatus {
    return this.status
  }

  getConfig(): ChannelConfig {
    return this.config
  }

  getId(): string {
    return this.config.id
  }

  on(eventType: string, handler: (event: ChannelEvent) => void): () => void {
    this.emitter.on(eventType, handler as (...args: unknown[]) => void)
    return () => {
      this.emitter.off(eventType, handler as (...args: unknown[]) => void)
    }
  }

  off(eventType: string, handler: (event: ChannelEvent) => void): void {
    this.emitter.off(eventType, handler as (...args: unknown[]) => void)
  }

  once(eventType: string, handler: (event: ChannelEvent) => void): void {
    this.emitter.once(eventType, handler as (...args: unknown[]) => void)
  }

  protected emit(event: ChannelEvent): void {
    this.emitter.emit(event.type, event)
  }

  protected setStatus(status: ChannelStatus): void {
    this.status = status
    this.emit({
      type: status === 'connected' ? 'connected' : status === 'error' ? 'error' : 'disconnected',
      channelId: this.config.id,
      timestamp: Date.now(),
    })
  }

  updateConfig(partial: Partial<ChannelConfig>): void {
    this.config = { ...this.config, ...partial }
  }
}

export class ChannelRegistry {
  private channels: Map<string, BaseChannel> = new Map()

  register(channel: BaseChannel): void {
    this.channels.set(channel.getId(), channel)
    console.log(`[ChannelRegistry] Registered channel: ${channel.name} (${channel.type})`)
  }

  unregister(channelId: string): void {
    const channel = this.channels.get(channelId)
    if (channel) {
      channel.disconnect().catch(console.error)
      this.channels.delete(channelId)
      console.log(`[ChannelRegistry] Unregistered channel: ${channelId}`)
    }
  }

  get(channelId: string): BaseChannel | undefined {
    return this.channels.get(channelId)
  }

  getByType(type: ChannelType): BaseChannel[] {
    return Array.from(this.channels.values()).filter(ch => ch.type === type)
  }

  getAll(): BaseChannel[] {
    return Array.from(this.channels.values())
  }

  getConnected(): BaseChannel[] {
    return this.getAll().filter(ch => ch.getStatus() === 'connected')
  }

  async connectAll(): Promise<void> {
    console.log(`[ChannelRegistry] Connecting to ${this.channels.size} channels...`)
    await Promise.all(
      Array.from(this.channels.values()).map(async ch => {
        if (ch.getConfig().enabled) {
          try {
            await ch.connect()
          } catch (error) {
            console.error(`[ChannelRegistry] Failed to connect ${ch.name}:`, error)
          }
        }
      }),
    )
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(
      Array.from(this.channels.values()).map(ch => ch.disconnect()),
    )
  }

  broadcast(content: string, excludeChannels?: string[]): Promise<void[]> {
    return Promise.all(
      this.getConnected()
        .filter(ch => !excludeChannels?.includes(ch.getId()))
        .map(async ch => {
          // Implementation depends on channel type
          console.log(`[ChannelRegistry] Broadcasting to ${ch.name}`)
        }),
    )
  }
}
