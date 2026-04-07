import { WebSocketServer, WebSocket } from 'ws'
import http from 'node:http'
import type { ToolUseContext, PermissionResult } from '../core/Tool.js'
import type { Message } from '../core/QueryEngine.ts'
import type { AppState } from '../core/Task.js'

export interface GatewayConfig {
  port: number
  host: string
  path?: string
  maxConnections?: number
  heartbeatInterval?: number
  authSecret?: string
}

export type GatewayClientStatus = 'connected' | 'authenticated' | 'disconnected' | 'error'

export interface GatewayClient {
  id: string
  ws: WebSocket
  status: GatewayClientStatus
  authenticated: boolean
  userId?: string
  permissions?: string[]
  connectedAt: number
  lastActivity: number
  metadata?: Record<string, unknown>
}

export type GatewayEventType =
  | 'client_connected'
  | 'client_disconnected'
  | 'client_authenticated'
  | 'message_received'
  | 'broadcast'
  | 'error'
  | 'tool_call'
  | 'response_sent'

export interface GatewayEvent {
  type: GatewayEventType
  clientId?: string
  data?: unknown
  timestamp: number
  error?: Error
}

export interface GatewayMessage {
  id: string
  type: 'request' | 'response' | 'event' | 'auth' | 'ping' | 'pong'
  payload: unknown
  timestamp: number
  clientId?: string
}

export class GatewayServer {
  private config: GatewayConfig
  private wss?: WebSocketServer
  private server?: http.Server
  private clients: Map<string, GatewayClient> = new Map()
  private eventHandlers: Map<GatewayEventType, Set<(event: GatewayEvent) => void>> = new Map()
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private isRunning = false

  constructor(config: Partial<GatewayConfig> = {}) {
    this.config = {
      port: 8080,
      host: '0.0.0.0',
      path: '/ws',
      maxConnections: 100,
      heartbeatInterval: 30000,
      ...config,
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[Gateway] Already running')
      return
    }

    this.server = http.createServer((req, res) => {
      if (req.url === this.config.path) {
        res.writeHead(200)
        res.end('openLittleTwo Gateway Server')
      }
    })

    this.wss = new WebSocketServer({
      server: this.server,
      path: this.config.path,
      maxPayload: 1024 * 1024, // 1MB
    })

    this.wss.on('connection', this.handleConnection.bind(this))
    this.wss.on('error', this.handleError.bind(this))

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        console.log(`[Gateway] Server started on ${this.config.host}:${this.config.port}`)
        resolve()
      })
      this.server!.on('error', reject)
    })

    this.startHeartbeat()
    this.isRunning = true

    this.emit({
      type: 'client_connected',
      data: { port: this.config.port },
      timestamp: Date.now(),
    })
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return
    }

    this.stopHeartbeat()

    // Disconnect all clients
    for (const [clientId, client] of this.clients) {
      this.disconnectClient(clientId, 'Server shutting down')
    }

    await new Promise<void>((resolve) => {
      this.wss?.close(() => {
        this.server?.close(() => {
          console.log('[Gateway] Server stopped')
          resolve()
        })
      })
    })

    this.isRunning = false
  }

  on(eventType: GatewayEventType, handler: (event: GatewayEvent) => void): () => void {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, new Set())
    }
    this.eventHandlers.get(eventType)!.add(handler)

    return () => {
      this.eventHandlers.get(eventType)?.delete(handler)
    }
  }

  sendToClient(clientId: string, message: Omit<GatewayMessage, 'id' | 'timestamp'>): boolean {
    const client = this.clients.get(clientId)
    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      return false
    }

    const fullMessage: GatewayMessage = {
      ...message,
      id: this.generateMessageId(),
      timestamp: Date.now(),
      clientId,
    }

    try {
      client.ws.send(JSON.stringify(fullMessage))
      return true
    } catch (error) {
      console.error(`[Gateway] Failed to send to client ${clientId}:`, error)
      return false
    }
  }

  broadcast(message: Omit<GatewayMessage, 'id' | 'timestamp' | 'clientId'>, excludeClients?: string[]): number {
    let sentCount = 0

    for (const [clientId, client] of this.clients) {
      if (excludeClients?.includes(clientId)) continue
      if (!client.authenticated) continue

      if (this.sendToClient(clientId, message)) {
        sentCount++
      }
    }

    this.emit({
      type: 'broadcast',
      data: { message, sentCount },
      timestamp: Date.now(),
    })

    return sentCount
  }

  getClient(clientId: string): GatewayClient | undefined {
    return this.clients.get(clientId)
  }

  getConnectedClients(): GatewayClient[] {
    return Array.from(this.clients.values()).filter(
      c => c.status === 'connected' || c.status === 'authenticated',
    )
  }

  getAuthenticatedClients(): GatewayClient[] {
    return Array.from(this.clients.values()).filter(c => c.authenticated)
  }

  getClientCount(): number {
    return this.clients.size
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    if (this.clients.size >= (this.config.maxConnections ?? 100)) {
      ws.close(1013, 'Server at capacity')
      return
    }

    const clientId = this.generateClientId()
    const client: GatewayClient = {
      id: clientId,
      ws,
      status: 'connected',
      authenticated: false,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
    }

    this.clients.set(clientId, client)

    ws.on('message', (data: Buffer) => this.handleMessage(clientId, data))
    ws.on('close', () => this.handleDisconnect(clientId))
    ws.on('error', (error) => this.handleClientError(clientId, error))
    ws.on('pong', () => this.updateClientActivity(clientId))

    console.log(`[Gateway] Client connected: ${clientId}`)

    this.emit({
      type: 'client_connected',
      clientId,
      data: { ip: req.socket.remoteAddress },
      timestamp: Date.now(),
    })
  }

  private async handleMessage(clientId: string, data: Buffer): Promise<void> {
    const client = this.clients.get(clientId)
    if (!client) return

    this.updateClientActivity(clientId)

    try {
      const message: GatewayMessage = JSON.parse(data.toString())

      switch (message.type) {
        case 'auth':
          await this.handleAuth(clientId, message.payload as Record<string, unknown>)
          break
        case 'ping':
          this.sendToClient(clientId, { type: 'pong', payload: {} })
          break
        case 'request':
          await this.handleRequest(clientId, message)
          break
        default:
          console.warn(`[Gateway] Unknown message type: ${message.type}`)
      }

      this.emit({
        type: 'message_received',
        clientId,
        data: message,
        timestamp: Date.now(),
      })
    } catch (error) {
      console.error(`[Gateway] Message parse error for ${clientId}:`, error)
      this.emit({
        type: 'error',
        clientId,
        error: error as Error,
        timestamp: Date.now(),
      })
    }
  }

  private async handleAuth(
    clientId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const client = this.clients.get(clientId)
    if (!client) return

    // Implement authentication logic here
    // For now, accept any token in development
    const token = payload.token as string
    
    if (token || process.env.NODE_ENV !== 'production') {
      client.authenticated = true
      client.userId = payload.userId as string
      client.permissions = payload.permissions as string[]
      client.status = 'authenticated'

      this.sendToClient(clientId, {
        type: 'auth',
        payload: { success: true, clientId },
      })

      console.log(`[Gateway] Client authenticated: ${clientId}`)

      this.emit({
        type: 'client_authenticated',
        clientId,
        data: { userId: client.userId },
        timestamp: Date.now(),
      })
    } else {
      this.sendToClient(clientId, {
        type: 'auth',
        payload: { success: false, error: 'Invalid token' },
      })
      
      setTimeout(() => this.disconnectClient(clientId, 'Authentication failed'), 1000)
    }
  }

  private async handleRequest(clientId: string, message: GatewayMessage): Promise<void> {
    const client = this.clients.get(clientId)
    if (!client || !client.authenticated) {
      this.sendToClient(clientId, {
        type: 'response',
        payload: { error: 'Not authenticated', requestId: message.id },
      })
      return
    }

    // Emit tool_call event for external handling
    this.emit({
      type: 'tool_call',
      clientId,
      data: message,
      timestamp: Date.now(),
    })
  }

  private handleDisconnect(clientId: string): void {
    const client = this.clients.get(clientId)
    if (!client) return

    console.log(`[Gateway] Client disconnected: ${clientId}`)
    this.clients.delete(clientId)

    this.emit({
      type: 'client_disconnected',
      clientId,
      timestamp: Date.now(),
    })
  }

  private handleClientError(clientId: string, error: Error): void {
    console.error(`[Gateway] Client error ${clientId}:`, error)
    this.disconnectClient(clientId, error.message)

    this.emit({
      type: 'error',
      clientId,
      error,
      timestamp: Date.now(),
    })
  }

  private disconnectClient(clientId: string, reason?: string): void {
    const client = this.clients.get(clientId)
    if (!client || client.ws.readyState !== WebSocket.OPEN) return

    client.ws.close(4001, reason ?? 'Disconnected')
    this.clients.delete(clientId)
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now()
      const timeout = (this.config.heartbeatInterval ?? 30000) * 2

      for (const [clientId, client] of this.clients) {
        if (now - client.lastActivity > timeout) {
          console.warn(`[Gateway] Client timed out: ${clientId}`)
          this.disconnectClient(clientId, 'Connection timeout')
        } else {
          client.ws.ping()
        }
      }
    }, this.config.heartbeatInterval)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  private updateClientActivity(clientId: string): void {
    const client = this.clients.get(clientId)
    if (client) {
      client.lastActivity = Date.now()
    }
  }

  private emit(event: GatewayEvent): void {
    const handlers = this.eventHandlers.get(event.type)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event)
        } catch (error) {
          console.error(`[Gateway] Event handler error (${event.type}):`, error)
        }
      }
    }
  }

  private generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
  }
}
