import { memoize } from 'lodash-es'
import type { AppState, AppConfig, ChannelState, PluginState } from './Task.js'

const DEFAULT_CONFIG: AppConfig = {
  appName: 'openLittleTwo',
  version: '1.0.0',
  debug: false,
  maxConcurrentTasks: 10,
  taskTimeout: 30000,
}

class StateManagerImpl {
  private state: AppState
  private listeners: Set<(state: AppState) => void> = new Set()
  private updateQueue: Array<() => void> = []
  private isUpdating = false

  constructor(initialConfig?: Partial<AppConfig>) {
    this.state = {
      tasks: new Map(),
      config: { ...DEFAULT_CONFIG, ...initialConfig },
      channels: new Map(),
      plugins: new Map(),
    }
  }

  getState(): AppState {
    return this.state
  }

  setState(updater: (prev: AppState) => AppState): void {
    this.updateQueue.push(() => {
      const newState = updater(this.state)
      this.state = newState
      this.notifyListeners()
    })

    if (!this.isUpdating) {
      this.processUpdateQueue()
    }
  }

  subscribe(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getTask(taskId: string): TaskStateBase | undefined {
    return this.state.tasks.get(taskId)
  }

  getAllTasks(): TaskStateBase[] {
    return Array.from(this.state.tasks.values())
  }

  getTasksByStatus(status: TaskStateBase['status']): TaskStateBase[] {
    return this.getAllTasks().filter(t => t.status === status)
  }

  getChannel(channelId: string): ChannelState | undefined {
    return this.state.channels.get(channelId)
  }

  getAllChannels(): ChannelState[] {
    return Array.from(this.state.channels.values())
  }

  getPlugin(pluginId: string): PluginState | undefined {
    return this.state.plugins.get(pluginId)
  }

  getAllPlugins(): PluginState[] {
    return Array.from(this.state.plugins.values())
  }

  getConfig(): AppConfig {
    return this.state.config
  }

  updateConfig(partial: Partial<AppConfig>): void {
    this.setState(prev => ({
      ...prev,
      config: { ...prev.config, ...partial },
    }))
  }

  private processUpdateQueue(): void {
    this.isUpdating = true

    while (this.updateQueue.length > 0) {
      const update = this.updateQueue.shift()
      update?.()
    }

    this.isUpdating = false
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state)
      } catch (error) {
        console.error('[StateManager] Listener error:', error)
      }
    }
  }
}

export const StateManager = (() => {
  let instance: StateManagerImpl | null = null

  return {
    getInstance: (config?: Partial<AppConfig>): StateManagerImpl => {
      if (!instance) {
        instance = new StateManagerImpl(config)
      }
      return instance
    },

    resetInstance: (): void => {
      instance = null
    },
  }
})()

export const getSystemContext = memoize(
  async (): Promise<Record<string, string>> => {
    const startTime = Date.now()
    const context: Record<string, string> = {}

    context.currentDate = `Today's date is ${new Date().toISOString().split('T')[0]}`

    context.appVersion = `openLittleTwo v${DEFAULT_CONFIG.version}`

    context.nodeVersion = process.version

    const duration = Date.now() - startTime
    console.log(`[ContextBuilder] System context built in ${duration}ms`)

    return context
  },
)

export const getUserContext = memoize(
  async (workspaceDir?: string): Promise<Record<string, string>> => {
    const startTime = Date.now()
    const context: Record<string, string> = {}

    if (workspaceDir) {
      context.workspaceDir = workspaceDir
    }

    const duration = Date.now() - startTime
    console.log(`[ContextBuilder] User context built in ${duration}ms`)

    return context
  },
)

export function clearContextCache(): void {
  ;(getSystemContext as any).cache?.clear?.()
  ;(getUserContext as any).cache?.clear?.()
}
