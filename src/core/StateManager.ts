import { memoize } from 'lodash-es'
import fs from 'node:fs'
import path from 'node:path'
import type {
  AppState,
  AppConfig,
  TaskConfig,
  ChannelState,
  PluginState,
} from './Task.js'
import { DEFAULT_TASK_CONFIG } from './Task.js'
import { TaskScheduler } from './TaskScheduler.js'
import { healthMonitor } from './HealthMonitor.js'

const DEFAULT_CONFIG: AppConfig = {
  appName: 'openLittleTwo',
  version: '1.0.0',
  debug: false,
  maxConcurrentTasks: 10,
  taskTimeout: 30000,
}

interface StateChangeEvent {
  type: 'tasks' | 'flows' | 'config' | 'channels' | 'plugins'
  action: 'upserted' | 'deleted' | 'updated'
  data?: unknown
  timestamp: number
}

type StateListener = (event: StateChangeEvent) => void

class StateManagerImpl {
  private state: AppState
  private listeners: Set<StateListener> = new Set()
  private updateQueue: Array<() => void> = []
  private isUpdating = false
  private persistenceTimer: ReturnType<typeof setInterval> | null = null
  private snapshotPath = '.openlittletwo/state.json'

  constructor(initialConfig?: Partial<AppConfig>) {
    const appConfig = { ...DEFAULT_CONFIG, ...initialConfig }
    this.state = {
      tasks: new Map(),
      flows: new Map(),
      config: { ...DEFAULT_TASK_CONFIG, appConfig },
      channels: new Map(),
      plugins: new Map(),
    } as AppState & { config: TaskConfig & { appConfig: AppConfig } }
    this.setupPersistence()
    this.setupTaskSchedulerIntegration()
  }

  private setupPersistence(): void {
    this.persistenceTimer = setInterval(() => {
      this.persistState()
    }, 30000)
  }

  private setupTaskSchedulerIntegration(): void {
    TaskScheduler.on('task_added', (task) => {
      this.emit({ type: 'tasks', action: 'upserted', data: task, timestamp: Date.now() })
    })

    TaskScheduler.on('task_completed', (task) => {
      this.emit({ type: 'tasks', action: 'updated', data: task, timestamp: Date.now() })
    })

    TaskScheduler.on('task_failed', (task) => {
      this.emit({ type: 'tasks', action: 'updated', data: task, timestamp: Date.now() })
    })

    TaskScheduler.on('flow_created', (flow) => {
      this.emit({ type: 'flows', action: 'upserted', data: flow, timestamp: Date.now() })
    })

    TaskScheduler.on('flow_completed', (flow) => {
      this.emit({ type: 'flows', action: 'updated', data: flow, timestamp: Date.now() })
    })
  }

  private persistState(): void {
    try {
      const dir = path.dirname(this.snapshotPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const snapshot = {
        config: this.state.config,
        timestamp: Date.now(),
      }
      fs.writeFileSync(this.snapshotPath, JSON.stringify(snapshot, null, 2))
    } catch (error) {
      console.error('[StateManager] Failed to persist state:', error)
    }
  }

  private emit(event: StateChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[StateManager] Listener error:', error)
      }
    }
  }

  getState(): AppState {
    return this.state
  }

  setState(updater: (prev: AppState) => AppState): void {
    this.updateQueue.push(() => {
      const newState = updater(this.state)
      this.state = newState
      this.emit({ type: 'config', action: 'updated', data: newState.config, timestamp: Date.now() })
    })

    if (!this.isUpdating) {
      this.processUpdateQueue()
    }
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private processUpdateQueue(): void {
    this.isUpdating = true

    while (this.updateQueue.length > 0) {
      const update = this.updateQueue.shift()
      update?.()
    }

    this.isUpdating = false
  }

  getTask(taskId: string): import('./Task.js').TaskRecord | undefined {
    return TaskScheduler.getTask(taskId)
  }

  getAllTasks(): import('./Task.js').TaskRecord[] {
    return TaskScheduler.getActiveTasks()
  }

  getTasksByStatus(status: import('./Task.js').TaskStatus): import('./Task.js').TaskRecord[] {
    return TaskScheduler.getActiveTasks().filter(t => t.status === status)
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

  getConfig(): TaskConfig & { appConfig: AppConfig } {
    return this.state.config as TaskConfig & { appConfig: AppConfig }
  }

  updateConfig(partial: Partial<TaskConfig>): void {
    this.setState(prev => ({
      ...prev,
      config: { ...prev.config, ...partial },
    }))
  }

  getHealthStatus() {
    return healthMonitor.getHealthStatus()
  }

  getSystemMetrics() {
    return healthMonitor.getSystemMetrics()
  }

  isHealthy(): boolean {
    return healthMonitor.isHealthy()
  }

  close(): void {
    if (this.persistenceTimer) {
      clearInterval(this.persistenceTimer)
      this.persistenceTimer = null
    }
    this.listeners.clear()
    this.persistState()
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
      if (instance) {
        instance.close()
      }
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

    if (StateManager.getInstance()) {
      const health = StateManager.getInstance().getHealthStatus()
      context.systemHealth = health.healthy ? 'healthy' : 'degraded'
    }

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

    const stats = TaskScheduler.getStats()
    context.runningTasks = String(stats.running)
    context.queuedTasks = String(stats.queued)

    const duration = Date.now() - startTime
    console.log(`[ContextBuilder] User context built in ${duration}ms`)

    return context
  },
)

export function clearContextCache(): void {
  ;(getSystemContext as any).cache?.clear?.()
  ;(getUserContext as any).cache?.clear?.()
}

export { StateManagerImpl }
export type { StateChangeEvent }
