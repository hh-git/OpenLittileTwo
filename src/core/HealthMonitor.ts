import { EventEmitter } from 'events'
import { TaskScheduler } from './TaskScheduler.js'

export interface HealthStatus {
  healthy: boolean
  timestamp: number
  checks: HealthCheckResult[]
  systemMetrics: SystemMetrics
}

export interface HealthCheckResult {
  name: string
  healthy: boolean
  message?: string
  lastChecked: number
  consecutiveFailures: number
  lastHealthy?: number
}

export interface SystemMetrics {
  memoryUsage: NodeJS.MemoryUsage
  cpuUsage: NodeJS.CpuUsage
  uptime: number
  taskStats: {
    running: number
    queued: number
    active: number
    totalTasks: number
    totalFlows: number
  }
}

export interface SelfHealingAction {
  type: 'restart' | 'retry' | 'recover' | 'escalate'
  target: string
  reason: string
  timestamp: number
  success?: boolean
}

export interface HealthMonitorConfig {
  checkIntervalMs: number
  unhealthyThreshold: number
  recoveryTimeoutMs: number
  enableSelfHealing: boolean
  maxRestartAttempts: number
  restartCooldownMs: number
}

export class HealthMonitor extends EventEmitter {
  private checks: Map<string, HealthCheckResult> = new Map()
  private config: HealthMonitorConfig
  private timer: ReturnType<typeof setInterval> | null = null
  private isRunning = false
  private selfHealingActions: SelfHealingAction[] = []
  private maxActionsHistory = 100

  constructor(config?: Partial<HealthMonitorConfig>) {
    super()
    this.config = {
      checkIntervalMs: config?.checkIntervalMs ?? 30000,
      unhealthyThreshold: config?.unhealthyThreshold ?? 3,
      recoveryTimeoutMs: config?.recoveryTimeoutMs ?? 60000,
      enableSelfHealing: config?.enableSelfHealing ?? true,
      maxRestartAttempts: config?.maxRestartAttempts ?? 3,
      restartCooldownMs: config?.restartCooldownMs ?? 300000,
    }

    this.initializeDefaultChecks()
  }

  private initializeDefaultChecks(): void {
    this.registerCheck('task_scheduler', async () => {
      const stats = TaskScheduler.getStats()
      if (stats.running + stats.queued > 1000) {
        return { healthy: true, message: `High load: ${stats.running} running, ${stats.queued} queued` }
      }
      return { healthy: true, message: 'Task scheduler operational' }
    })

    this.registerCheck('memory', async () => {
      const usage = process.memoryUsage()
      const heapUsedPercent = (usage.heapUsed / usage.heapTotal) * 100
      if (heapUsedPercent > 90) {
        return { healthy: false, message: `Heap usage critical: ${heapUsedPercent.toFixed(1)}%` }
      }
      if (heapUsedPercent > 75) {
        return { healthy: true, message: `Heap usage elevated: ${heapUsedPercent.toFixed(1)}%` }
      }
      return { healthy: true, message: `Memory healthy: ${heapUsedPercent.toFixed(1)}%` }
    })

    this.registerCheck('event_loop', async () => {
      const start = Date.now()
      await new Promise(resolve => setImmediate(resolve))
      const lag = Date.now() - start
      if (lag > 100) {
        return { healthy: false, message: `Event loop lag: ${lag}ms` }
      }
      return { healthy: true, message: `Event loop healthy: ${lag}ms lag` }
    })
  }

  registerCheck(name: string, checkFn: () => Promise<{ healthy: boolean; message?: string }>): void {
    this.checks.set(name, {
      name,
      healthy: true,
      lastChecked: 0,
      consecutiveFailures: 0,
    })

    const runCheck = async () => {
      const current = this.checks.get(name)
      if (!current) return

      try {
        const result = await checkFn()
        current.lastChecked = Date.now()
        current.message = result.message

        if (result.healthy) {
          if (!current.healthy) {
            current.lastHealthy = Date.now()
            this.emit('recovery', { check: name, message: result.message })
          }
          current.healthy = true
          current.consecutiveFailures = 0
        } else {
          current.healthy = false
          current.consecutiveFailures++
          this.emit('degradation', { check: name, message: result.message, failures: current.consecutiveFailures })

          if (this.config.enableSelfHealing && current.consecutiveFailures >= this.config.unhealthyThreshold) {
            await this.performSelfHealing(name)
          }
        }

        this.emit('check_completed', { check: name, result: current })
      } catch (error) {
        current.healthy = false
        current.consecutiveFailures++
        current.message = `Check error: ${error}`
        this.emit('check_error', { check: name, error })
      }
    }

    this.checks.get(name)!.lastChecked = Date.now()
    setInterval(runCheck, this.config.checkIntervalMs)
  }

  private async performSelfHealing(checkName: string): Promise<void> {
    const action: SelfHealingAction = {
      type: this.determineHealingAction(checkName),
      target: checkName,
      reason: `Consecutive failures: ${this.checks.get(checkName)?.consecutiveFailures}`,
      timestamp: Date.now(),
    }

    this.emit('self_healing_start', { check: checkName, action })

    try {
      switch (action.type) {
        case 'restart':
          await this.performRestart(checkName)
          action.success = true
          break
        case 'retry':
          await this.performRetry(checkName)
          action.success = true
          break
        case 'recover':
          await this.performRecover(checkName)
          action.success = true
          break
        case 'escalate':
          action.success = false
          this.emit('escalation', { check: checkName, reason: action.reason })
          break
      }
    } catch (error) {
      action.success = false
      this.emit('self_healing_error', { check: checkName, action, error })
    }

    this.selfHealingActions.push(action)
    if (this.selfHealingActions.length > this.maxActionsHistory) {
      this.selfHealingActions.shift()
    }

    this.emit('self_healing_complete', { check: checkName, action })
  }

  private determineHealingAction(checkName: string): SelfHealingAction['type'] {
    const recentActions = this.selfHealingActions
      .filter(a => a.target === checkName && Date.now() - a.timestamp < this.config.restartCooldownMs)

    if (recentActions.length >= this.config.maxRestartAttempts) {
      return 'escalate'
    }

    switch (checkName) {
      case 'memory':
        return 'recover'
      case 'task_scheduler':
        return 'restart'
      default:
        return 'retry'
    }
  }

  private async performRestart(checkName: string): Promise<void> {
    this.emit('log', { level: 'warn', message: `Self-healing: Restarting ${checkName}` })

    if (checkName === 'task_scheduler') {
      await TaskScheduler.stop()
      await new Promise(resolve => setTimeout(resolve, 1000))
      await TaskScheduler.start()
    }
  }

  private async performRetry(checkName: string): Promise<void> {
    this.emit('log', { level: 'info', message: `Self-healing: Retrying ${checkName}` })
    await new Promise(resolve => setTimeout(resolve, 5000))
  }

  private async performRecover(checkName: string): Promise<void> {
    this.emit('log', { level: 'info', message: `Self-healing: Recovery action for ${checkName}` })

    if (checkName === 'memory') {
      if (global.gc) {
        global.gc()
        this.emit('log', { level: 'info', message: 'Self-healing: Triggered garbage collection' })
      }
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true

    await this.runAllChecks()
    this.timer = setInterval(() => this.runAllChecks(), this.config.checkIntervalMs)

    this.emit('started')
    console.log('[HealthMonitor] Started')
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return
    this.isRunning = false

    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    this.emit('stopped')
    console.log('[HealthMonitor] Stopped')
  }

  private async runAllChecks(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const [name] of this.checks) {
      promises.push(this.runCheck(name))
    }
    await Promise.all(promises)
  }

  private async runCheck(name: string): Promise<void> {
    const check = this.checks.get(name)
    if (!check) return
    check.lastChecked = Date.now()
  }

  getHealthStatus(): HealthStatus {
    const results: HealthCheckResult[] = []
    let allHealthy = true

    for (const check of this.checks.values()) {
      results.push({ ...check })
      if (!check.healthy) allHealthy = false
    }

    return {
      healthy: allHealthy,
      timestamp: Date.now(),
      checks: results,
      systemMetrics: this.getSystemMetrics(),
    }
  }

  getSystemMetrics(): SystemMetrics {
    const stats = TaskScheduler.getStats()
    return {
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage(),
      uptime: process.uptime(),
      taskStats: stats,
    }
  }

  getRecentActions(limit = 10): SelfHealingAction[] {
    return this.selfHealingActions.slice(-limit)
  }

  isHealthy(): boolean {
    return this.getHealthStatus().healthy
  }

  getCheck(name: string): HealthCheckResult | undefined {
    return this.checks.get(name)
  }

  getAllChecks(): HealthCheckResult[] {
    return Array.from(this.checks.values())
  }
}

export const healthMonitor = new HealthMonitor()
