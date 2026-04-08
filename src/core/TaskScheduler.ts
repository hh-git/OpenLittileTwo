import { EventEmitter } from 'events'
import {
  isTerminalTaskStatus,
  isActiveTaskStatus,
  isTerminalFlowStatus,
  createTaskRecordBase,
  createTaskFlowRecord,
  generateTaskId,
  generateFlowId,
  generateRunId,
  calculateRetryDelay,
  shouldRetryTask,
  compareTaskPriority,
  DEFAULT_TASK_CONFIG,
  getTaskPriorityWeight,
  type TaskRecord,
  type TaskFlowRecord,
  type TaskStatus,
  type TaskPriority,
  type TaskConfig,
  type TaskEventRecord,
  type DeliveryContext,
  type TaskRuntime,
  type TaskScopeKind,
  type TaskDeliveryStatus,
  type TaskNotifyPolicy,
  type TaskFlowStatus,
} from './Task.js'
import {
  loadTaskRegistrySnapshot,
  saveTaskRegistrySnapshot,
  upsertTaskToStorage,
  upsertFlowToStorage,
  upsertDeliveryStateToStorage,
  deleteTaskFromStorage,
  deleteFlowFromStorage,
  closeStorage,
  setStoragePath,
  type TaskDeliveryState as TaskDeliveryStateType,
} from './TaskStorage.js'

export type TaskSchedulerEvent =
  | 'task_added'
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'task_retry'
  | 'task_cancelled'
  | 'task_progress'
  | 'flow_created'
  | 'flow_completed'
  | 'flow_failed'
  | 'flow_blocked'
  | 'health_check'
  | 'error'

export interface ScheduledTask {
  task: TaskRecord
  scheduledAt: number
  executeAt: number
  recurring?: boolean
  intervalMs?: number
}

export interface TaskExecutorFactory {
  createExecutor(task: TaskRecord): TaskExecutorInstance
}

export interface TaskExecutorInstance {
  taskId: string
  execute(context: TaskExecutionContext): Promise<TaskExecutionResult>
  abort(): void
}

export interface TaskExecutionContext {
  abortController: AbortController
  onProgress: (progress: string) => void
  onEvent: (event: TaskEventRecord) => void
}

export interface TaskExecutionResult {
  success: boolean
  output?: string
  error?: string
  terminalStatus: 'completed' | 'failed' | 'timed_out' | 'cancelled'
  terminalOutcome?: 'succeeded' | 'blocked'
  progressSummary?: string
}

export interface TaskRegistrySnapshot {
  tasks: TaskRecord[]
  flows: TaskFlowRecord[]
  timestamp: number
}

class TaskRegistry {
  private tasks: Map<string, TaskRecord> = new Map()
  private flows: Map<string, TaskFlowRecord> = new Map()
  private taskDeliveryStates: Map<string, TaskDeliveryStateType> = new Map()
  private taskIdsByRunId: Map<string, Set<string>> = new Map()
  private taskIdsByOwnerKey: Map<string, Set<string>> = new Map()
  private taskIdsByParentFlowId: Map<string, Set<string>> = new Map()
  private taskIdsByRelatedSessionKey: Map<string, Set<string>> = new Map()
  private tasksWithPendingDelivery: Set<string> = new Set()
  private listeners: Map<string, Set<(event: string) => void>> = new Map()
  private useSqlite = true

  constructor() {
    this.restore()
  }

  private restore(): void {
    try {
      const snapshot = loadTaskRegistrySnapshot()
      for (const task of snapshot.tasks.values()) {
        this.tasks.set(task.taskId, task)
        this.indexTask(task)
      }
      for (const flow of snapshot.flows.values()) {
        this.flows.set(flow.flowId, flow)
      }
      if (snapshot.deliveryStates) {
        for (const state of snapshot.deliveryStates.values()) {
          this.taskDeliveryStates.set(state.taskId, state)
        }
      }
    } catch (error) {
      console.warn('[TaskRegistry] Failed to load from SQLite, starting fresh:', error)
    }
  }

  private persist(): void {
    try {
      if (this.useSqlite) {
        for (const task of this.tasks.values()) {
          upsertTaskToStorage(task)
        }
        for (const flow of this.flows.values()) {
          upsertFlowToStorage(flow)
        }
        return
      }

      saveTaskRegistrySnapshot({
        tasks: this.tasks,
        flows: this.flows,
        deliveryStates: this.taskDeliveryStates,
      })
    } catch (error) {
      console.error('[TaskRegistry] Failed to persist state:', error)
    }
  }

  setStoragePath(dbPath: string): void {
    setStoragePath(dbPath)
  }

  enableSqlite(enable: boolean): void {
    this.useSqlite = enable
  }

  private indexTask(task: TaskRecord): void {
    if (task.runId) {
      let ids = this.taskIdsByRunId.get(task.runId)
      if (!ids) {
        ids = new Set()
        this.taskIdsByRunId.set(task.runId, ids)
      }
      ids.add(task.taskId)
    }
    if (task.ownerKey) {
      let ids = this.taskIdsByOwnerKey.get(task.ownerKey)
      if (!ids) {
        ids = new Set()
        this.taskIdsByOwnerKey.set(task.ownerKey, ids)
      }
      ids.add(task.taskId)
    }
    if (task.parentFlowId) {
      let ids = this.taskIdsByParentFlowId.get(task.parentFlowId)
      if (!ids) {
        ids = new Set()
        this.taskIdsByParentFlowId.set(task.parentFlowId, ids)
      }
      ids.add(task.taskId)
    }
  }

  private unindexTask(task: TaskRecord): void {
    if (task.runId) {
      const ids = this.taskIdsByRunId.get(task.runId)
      if (ids) {
        ids.delete(task.taskId)
        if (ids.size === 0) this.taskIdsByRunId.delete(task.runId)
      }
    }
    if (task.ownerKey) {
      const ids = this.taskIdsByOwnerKey.get(task.ownerKey)
      if (ids) {
        ids.delete(task.taskId)
        if (ids.size === 0) this.taskIdsByOwnerKey.delete(task.ownerKey)
      }
    }
    if (task.parentFlowId) {
      const ids = this.taskIdsByParentFlowId.get(task.parentFlowId)
      if (ids) {
        ids.delete(task.taskId)
        if (ids.size === 0) this.taskIdsByParentFlowId.delete(task.parentFlowId)
      }
    }
  }

  on(event: string, handler: (event: string) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(handler)
    return () => this.listeners.get(event)?.delete(handler)
  }

  private emit(event: string, data?: unknown): void {
    const handlers = this.listeners.get(event)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(String(data))
        } catch (error) {
          console.error(`[TaskRegistry] Event handler error (${event}):`, error)
        }
      }
    }
  }

  createTask(params: {
    runtime: TaskRuntime
    taskKind?: string
    ownerKey: string
    scopeKind?: TaskScopeKind
    task: string
    label?: string
    priority?: TaskPriority
    maxRetries?: number
    dependencies?: string[]
    parentFlowId?: string
    parentTaskId?: string
    runId?: string
    childSessionKey?: string
    agentId?: string
    metadata?: Record<string, unknown>
    requesterOrigin?: DeliveryContext
  }): TaskRecord {
    const task = createTaskRecordBase(params)
    this.tasks.set(task.taskId, task)
    this.indexTask(task)
    this.persist()
    this.emit('task_added', task)
    return task
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  updateTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord | null {
    const current = this.tasks.get(taskId)
    if (!current) return null

    const next = { ...current, ...patch }
    this.tasks.set(taskId, next)
    this.unindexTask(current)
    this.indexTask(next)
    this.persist()
    return next
  }

  markTaskTerminal(
    taskId: string,
    status: 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'lost',
    error?: string,
    terminalOutcome?: 'succeeded' | 'blocked',
    terminalSummary?: string
  ): TaskRecord | null {
    const now = Date.now()
    return this.updateTask(taskId, {
      status,
      endedAt: now,
      lastEventAt: now,
      error,
      terminalOutcome,
      terminalSummary,
      cleanupAfter: now + DEFAULT_TASK_CONFIG.retentionMs,
    })
  }

  getTasksByStatus(status: TaskStatus): TaskRecord[] {
    return Array.from(this.tasks.values()).filter(t => t.status === status)
  }

  getTasksByOwnerKey(ownerKey: string): TaskRecord[] {
    const ids = this.taskIdsByOwnerKey.get(ownerKey)
    if (!ids) return []
    return [...ids].map(id => this.tasks.get(id)).filter((t): t is TaskRecord => Boolean(t))
  }

  getTasksByFlowId(flowId: string): TaskRecord[] {
    const ids = this.taskIdsByParentFlowId.get(flowId)
    if (!ids) return []
    return [...ids].map(id => this.tasks.get(id)).filter((t): t is TaskRecord => Boolean(t))
  }

  getActiveTasks(): TaskRecord[] {
    return Array.from(this.tasks.values()).filter(t => isActiveTaskStatus(t.status))
  }

  getQueuedTasks(): TaskRecord[] {
    return Array.from(this.tasks.values())
      .filter(t => t.status === 'queued')
      .sort(compareTaskPriority)
  }

  deleteTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false
    this.unindexTask(task)
    this.tasks.delete(taskId)
    this.taskDeliveryStates.delete(taskId)
    this.persist()
    return true
  }

  createFlow(params: {
    ownerKey: string
    goal: string
    controllerId?: string
    syncMode?: 'managed' | 'task_mirrored'
    requesterOrigin?: DeliveryContext
  }): TaskFlowRecord {
    const flow = createTaskFlowRecord(params)
    this.flows.set(flow.flowId, flow)
    this.persist()
    this.emit('flow_created', flow)
    return flow
  }

  getFlow(flowId: string): TaskFlowRecord | undefined {
    return this.flows.get(flowId)
  }

  updateFlow(flowId: string, patch: Partial<TaskFlowRecord>): TaskFlowRecord | null {
    const current = this.flows.get(flowId)
    if (!current) return null

    const next = { ...current, ...patch, revision: current.revision + 1, updatedAt: Date.now() }
    this.flows.set(flowId, next)
    this.persist()
    return next
  }

  getFlowsByOwnerKey(ownerKey: string): TaskFlowRecord[] {
    return Array.from(this.flows.values()).filter(f => f.ownerKey === ownerKey)
  }

  getSnapshot(): TaskRegistrySnapshot {
    return {
      tasks: Array.from(this.tasks.values()),
      flows: Array.from(this.flows.values()),
      timestamp: Date.now(),
    }
  }

  close(): void {
    closeStorage()
  }
}

class TaskSchedulerImpl {
  private config: TaskConfig
  private registry: TaskRegistry
  private executorFactory: TaskExecutorFactory | null = null
  private runningTasks: Map<string, { abortController: AbortController; promise: Promise<void> }> = new Map()
  private scheduledTasks: Map<string, ScheduledTask> = new Map()
  private retryTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null
  private isRunning = false
  private isShuttingDown = false
  private listeners: Map<string, Set<(event: TaskSchedulerEvent) => void>> = new Map()
  private dependencyGraph: Map<string, Set<string>> = new Map()

  constructor(config?: Partial<TaskConfig>) {
    this.config = { ...DEFAULT_TASK_CONFIG, ...config }
    this.registry = new TaskRegistry()
    this.setupEventHandlers()
  }

  private setupEventHandlers(): void {
    this.registry.on('task_added', (task) => this.emit('task_added', task))
    this.registry.on('task_completed', (task) => this.emit('task_completed', task))
    this.registry.on('task_failed', (task) => this.emit('task_failed', task))
    this.registry.on('task_retry', (task) => this.emit('task_retry', task))
    this.registry.on('task_cancelled', (task) => this.emit('task_cancelled', task))
    this.registry.on('task_progress', (task) => this.emit('task_progress', task))
    this.registry.on('flow_created', (flow) => this.emit('flow_created', flow))
    this.registry.on('flow_completed', (flow) => this.emit('flow_completed', flow))
    this.registry.on('flow_failed', (flow) => this.emit('flow_failed', flow))
    this.registry.on('flow_blocked', (flow) => this.emit('flow_blocked', flow))
  }

  on(event: TaskSchedulerEvent, handler: (data?: unknown) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(handler)
    return () => this.listeners.get(event)?.delete(handler)
  }

  private emit(event: TaskSchedulerEvent, data?: unknown): void {
    const handlers = this.listeners.get(event)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data as TaskSchedulerEvent)
        } catch (error) {
          console.error(`[TaskScheduler] Event handler error (${event}):`, error)
        }
      }
    }
  }

  setExecutorFactory(factory: TaskExecutorFactory): void {
    this.executorFactory = factory
  }

  async start(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    this.startHealthCheck()
    console.log('[TaskScheduler] Started')
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return
    this.isShuttingDown = true
    this.stopHealthCheck()
    await this.gracefulShutdown()
    this.isRunning = false
    this.isShuttingDown = false
    console.log('[TaskScheduler] Stopped')
  }

  async gracefulShutdown(): Promise<void> {
    console.log('[TaskScheduler] Initiating graceful shutdown...')
    const killPromises: Promise<void>[] = []
    for (const [taskId, running] of this.runningTasks) {
      console.log(`[TaskScheduler] Killing task: ${taskId}`)
      running.abortController.abort()
      killPromises.push(running.promise.catch(() => {}))
    }
    for (const timeout of this.retryTimeouts.values()) {
      clearTimeout(timeout)
    }
    await Promise.allSettled(killPromises)
    this.registry.close()
    console.log('[TaskScheduler] Graceful shutdown complete')
  }

  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck()
    }, this.config.healthCheckIntervalMs)
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
  }

  private performHealthCheck(): void {
    const now = Date.now()
    const running = this.runningTasks.size
    const queued = this.registry.getQueuedTasks().length
    const active = this.registry.getActiveTasks().length

    let staleTasks = 0
    for (const [taskId, runningTask] of this.runningTasks) {
      const task = this.registry.getTask(taskId)
      if (task?.startedAt && now - task.startedAt > this.config.taskTimeout) {
        staleTasks++
        this.handleTaskTimeout(taskId)
      }
    }

    this.emit('health_check', {
      timestamp: now,
      runningTasks: running,
      queuedTasks: queued,
      activeTasks: active,
      staleTasks,
    })

    this.processScheduledTasks(now)
    this.scheduleQueuedTasks()
  }

  private processScheduledTasks(now: number): void {
    for (const [taskId, scheduled] of this.scheduledTasks) {
      if (scheduled.executeAt <= now) {
        if (scheduled.recurring && scheduled.intervalMs) {
          scheduled.executeAt = now + scheduled.intervalMs
        } else {
          this.scheduledTasks.delete(taskId)
        }
        this.scheduleTask(scheduled.task)
      }
    }
  }

  private handleTaskTimeout(taskId: string): void {
    console.warn(`[TaskScheduler] Task timed out: ${taskId}`)
    this.abortTask(taskId)
    const task = this.registry.getTask(taskId)
    if (task) {
      this.registry.markTaskTerminal(taskId, 'timed_out', 'Task execution timed out')
      this.emit('task_failed', task)
    }
  }

  private scheduleQueuedTasks(): void {
    if (this.isShuttingDown) return
    const runningCount = this.runningTasks.size
    if (runningCount >= this.config.maxConcurrentTasks) return

    const availableSlots = this.config.maxConcurrentTasks - runningCount
    const queuedTasks = this.registry.getQueuedTasks()

    for (const task of queuedTasks.slice(0, availableSlots)) {
      if (this.canScheduleTask(task)) {
        this.startTask(task.taskId)
      }
    }
  }

  private canScheduleTask(task: TaskRecord): boolean {
    if (!isActiveTaskStatus(task.status)) return false
    if (this.runningTasks.has(task.taskId)) return false
    if (task.dependencies && task.dependencies.length > 0) {
      for (const depId of task.dependencies) {
        const dep = this.registry.getTask(depId)
        if (!dep || !isTerminalTaskStatus(dep.status)) {
          return false
        }
      }
    }
    return true
  }

  scheduleTask(task: TaskRecord): void {
    if (this.dependencyGraph.has(task.taskId)) return
    const deps = task.dependencies ?? []
    if (deps.length > 0) {
      this.dependencyGraph.set(task.taskId, new Set(deps))
    }
    this.scheduleQueuedTasks()
  }

  scheduleRecurring(params: {
    task: Omit<TaskRecord, 'taskId' | 'status' | 'createdAt' | 'lastEventAt'>
    intervalMs: number
    startDelayMs?: number
  }): string {
    const task = this.registry.createTask({
      ...params.task,
      taskKind: params.task.taskKind ?? 'scheduled',
    } as Parameters<typeof this.registry.createTask>[0])

    const now = Date.now()
    this.scheduledTasks.set(task.taskId, {
      task,
      scheduledAt: now,
      executeAt: now + (params.startDelayMs ?? 0),
      recurring: true,
      intervalMs: params.intervalMs,
    })

    return task.taskId
  }

  cancelRecurring(taskId: string): boolean {
    return this.scheduledTasks.delete(taskId)
  }

  async startTask(taskId: string): Promise<void> {
    if (this.isShuttingDown) return

    const task = this.registry.getTask(taskId)
    if (!task || !this.canScheduleTask(task)) return

    if (!this.executorFactory) {
      console.error('[TaskScheduler] No executor factory set')
      return
    }

    const abortController = new AbortController()
    const executor = this.executorFactory.createExecutor(task)

    const taskPromise = this.executeTask(taskId, executor, abortController)
    this.runningTasks.set(taskId, { abortController, promise: taskPromise })

    this.registry.updateTask(taskId, {
      status: 'running',
      startedAt: Date.now(),
      lastEventAt: Date.now(),
    })

    this.emit('task_started', task)

    taskPromise
      .then(() => {
        this.runningTasks.delete(taskId)
        this.scheduleQueuedTasks()
      })
      .catch((error) => {
        this.runningTasks.delete(taskId)
        console.error(`[TaskScheduler] Task execution error: ${taskId}`, error)
        this.scheduleQueuedTasks()
      })
  }

  private async executeTask(
    taskId: string,
    executor: TaskExecutorInstance,
    abortController: AbortController
  ): Promise<void> {
    const context: TaskExecutionContext = {
      abortController,
      onProgress: (progress: string) => {
        this.registry.updateTask(taskId, { progressSummary: progress })
        this.emit('task_progress', { taskId, progress })
      },
      onEvent: (event: TaskEventRecord) => {
        const task = this.registry.getTask(taskId)
        if (task) {
          this.emit('task_progress', { taskId, event })
        }
      },
    }

    try {
      const result = await executor.execute(context)

      if (abortController.signal.aborted) {
        this.registry.markTaskTerminal(taskId, 'cancelled')
        this.emit('task_cancelled', this.registry.getTask(taskId))
        return
      }

      if (result.success) {
        const updated = this.registry.markTaskTerminal(
          taskId,
          'completed',
          undefined,
          result.terminalOutcome ?? 'succeeded',
          result.progressSummary
        )
        this.emit('task_completed', updated)
        this.handleTaskCompletion(taskId)
      } else {
        await this.handleTaskFailure(taskId, result.error ?? 'Unknown error')
      }
    } catch (error) {
      await this.handleTaskFailure(taskId, String(error))
    }
  }

  private handleTaskCompletion(taskId: string): void {
    const flowId = this.registry.getTask(taskId)?.parentFlowId
    if (!flowId) return

    const flowTasks = this.registry.getTasksByFlowId(flowId)
    const allCompleted = flowTasks.every(t => isTerminalTaskStatus(t.status))
    const anyFailed = flowTasks.some(t => t.status === 'failed')

    if (allCompleted) {
      if (anyFailed) {
        this.registry.updateFlow(flowId, { status: 'failed' })
        this.emit('flow_failed', this.registry.getFlow(flowId))
      } else {
        this.registry.updateFlow(flowId, { status: 'succeeded', endedAt: Date.now() })
        this.emit('flow_completed', this.registry.getFlow(flowId))
      }
    }
  }

  private async handleTaskFailure(taskId: string, error: string): Promise<void> {
    const task = this.registry.getTask(taskId)
    if (!task) return

    if (shouldRetryTask(task)) {
      const delay = calculateRetryDelay(task.retryCount)
      const retryTask: TaskRecord = {
        ...task,
        status: 'retrying',
        retryCount: task.retryCount + 1,
        retryDelayMs: delay,
        lastEventAt: Date.now(),
      }
      this.registry.updateTask(taskId, retryTask)
      this.emit('task_retry', retryTask)

      const timeout = setTimeout(() => {
        this.retryTimeouts.delete(taskId)
        this.registry.updateTask(taskId, { status: 'queued' })
        this.scheduleQueuedTasks()
      }, delay)

      this.retryTimeouts.set(taskId, timeout)
    } else {
      const updated = this.registry.markTaskTerminal(
        taskId,
        'failed',
        error,
        undefined,
        `Failed after ${task.retryCount} retries`
      )
      this.emit('task_failed', updated)
      this.handleTaskCompletion(taskId)
    }
  }

  abortTask(taskId: string): boolean {
    const running = this.runningTasks.get(taskId)
    if (running) {
      running.abortController.abort()
      this.runningTasks.delete(taskId)
      return true
    }
    return false
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.registry.getTask(taskId)
    if (!task) return false

    this.abortTask(taskId)
    this.scheduledTasks.delete(taskId)

    const timeout = this.retryTimeouts.get(taskId)
    if (timeout) {
      clearTimeout(timeout)
      this.retryTimeouts.delete(taskId)
    }

    const updated = this.registry.markTaskTerminal(taskId, 'cancelled')
    this.emit('task_cancelled', updated)
    return true
  }

  async cancelFlow(flowId: string): Promise<boolean> {
    const flow = this.registry.getFlow(flowId)
    if (!flow) return false

    this.registry.updateFlow(flowId, { status: 'cancelled', cancelRequestedAt: Date.now() })

    const tasks = this.registry.getTasksByFlowId(flowId)
    for (const task of tasks) {
      await this.cancelTask(task.taskId)
    }

    return true
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.registry.getTask(taskId)
  }

  getFlow(flowId: string): TaskFlowRecord | undefined {
    return this.registry.getFlow(flowId)
  }

  getRunningTasks(): TaskRecord[] {
    return Array.from(this.runningTasks.keys())
      .map(id => this.registry.getTask(id))
      .filter((t): t is TaskRecord => Boolean(t))
  }

  getQueuedTasks(): TaskRecord[] {
    return this.registry.getQueuedTasks()
  }

  getActiveTasks(): TaskRecord[] {
    return this.registry.getActiveTasks()
  }

  getTasksByOwnerKey(ownerKey: string): TaskRecord[] {
    return this.registry.getTasksByOwnerKey(ownerKey)
  }

  getTasksByFlowId(flowId: string): TaskRecord[] {
    return this.registry.getTasksByFlowId(flowId)
  }

  getFlowsByOwnerKey(ownerKey: string): TaskFlowRecord[] {
    return this.registry.getFlowsByOwnerKey(ownerKey)
  }

  getStats(): {
    running: number
    queued: number
    active: number
    totalTasks: number
    totalFlows: number
  } {
    return {
      running: this.runningTasks.size,
      queued: this.registry.getQueuedTasks().length,
      active: this.registry.getActiveTasks().length,
      totalTasks: this.registry.getSnapshot().tasks.length,
      totalFlows: this.registry.getSnapshot().flows.length,
    }
  }

  createFlow(params: {
    ownerKey: string
    goal: string
    controllerId?: string
    syncMode?: 'managed' | 'task_mirrored'
    requesterOrigin?: DeliveryContext
  }): TaskFlowRecord {
    return this.registry.createFlow(params)
  }

  createTaskInFlow(params: {
    flowId: string
    runtime: TaskRuntime
    ownerKey: string
    task: string
    label?: string
    priority?: TaskPriority
    dependencies?: string[]
  }): TaskRecord | null {
    const flow = this.registry.getFlow(params.flowId)
    if (!flow || isTerminalFlowStatus(flow.status)) return null

    const task = this.registry.createTask({
      ...params,
      parentFlowId: params.flowId,
      scopeKind: 'session',
      runId: flow.flowId,
    })

    return task
  }
}

export const TaskScheduler = new TaskSchedulerImpl()

export { TaskRegistry, TaskSchedulerImpl }
