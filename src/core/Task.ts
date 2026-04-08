import { randomBytes, createHash } from 'crypto'
import { EventEmitter } from 'events'

export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'remote_agent'
  | 'in_process_teammate'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'channel_message'
  | 'plugin_task'
  | 'gateway_request'
  | 'scheduled'

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'paused'
  | 'retrying'
  | 'blocked'
  | 'timed_out'
  | 'lost'
  | 'cancelled'

export type TaskTerminalStatus = Extract<TaskStatus, 'completed' | 'failed' | 'killed' | 'timed_out' | 'lost'>

export type TaskFlowStatus =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'lost'

export type TaskRuntime = 'cli' | 'acp' | 'subagent' | 'system'
export type TaskScopeKind = 'session' | 'system'

export type TaskDeliveryStatus =
  | 'pending'
  | 'delivered'
  | 'session_queued'
  | 'not_applicable'
  | 'parent_missing'
  | 'failed'

export type TaskNotifyPolicy = 'silent' | 'done_only' | 'all'

export type TaskTerminalOutcome = 'succeeded' | 'blocked'

export interface TaskEventRecord {
  at: number
  kind: TaskStatus | 'progress'
  summary?: string
}

export interface TaskRecord {
  taskId: string
  runtime: TaskRuntime
  taskKind?: string
  sourceId?: string
  requesterSessionKey: string
  ownerKey: string
  scopeKind: TaskScopeKind
  childSessionKey?: string
  parentFlowId?: string
  parentTaskId?: string
  agentId?: string
  runId?: string
  label?: string
  task: string
  status: TaskStatus
  deliveryStatus: TaskDeliveryStatus
  notifyPolicy: TaskNotifyPolicy
  createdAt: number
  startedAt?: number
  endedAt?: number
  lastEventAt: number
  cleanupAfter?: number
  progressSummary?: string
  terminalSummary?: string
  terminalOutcome?: TaskTerminalOutcome
  error?: string
  retryCount: number
  maxRetries: number
  retryDelayMs?: number
  priority: TaskPriority
  dependencies?: string[]
  outputFile: string
  outputOffset: number
  notified: boolean
  metadata?: Record<string, unknown>
}

export interface TaskFlowRecord {
  flowId: string
  syncMode: 'managed' | 'task_mirrored'
  ownerKey: string
  requesterOrigin?: DeliveryContext
  controllerId?: string
  revision: number
  status: TaskFlowStatus
  notifyPolicy: TaskNotifyPolicy
  goal: string
  currentStep?: string
  blockedTaskId?: string
  blockedSummary?: string
  stateJson?: unknown
  waitJson?: unknown
  cancelRequestedAt?: number
  createdAt: number
  updatedAt: number
  endedAt?: number
}

export interface DeliveryContext {
  channel?: string
  to?: string
  accountId?: string
  threadId?: string | number
}

export type TaskPriority = 'low' | 'normal' | 'high' | 'critical'

export interface TaskConfig {
  maxConcurrentTasks: number
  taskTimeout: number
  defaultRetryDelayMs: number
  maxRetries: number
  retryBackoffMultiplier: number
  maxRetryDelayMs: number
  retentionMs: number
  healthCheckIntervalMs: number
}

const DEFAULT_TASK_CONFIG: TaskConfig = {
  maxConcurrentTasks: 10,
  taskTimeout: 300000,
  defaultRetryDelayMs: 1000,
  maxRetries: 3,
  retryBackoffMultiplier: 2,
  maxRetryDelayMs: 60000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  healthCheckIntervalMs: 30000,
}

const TASK_PRIORITY_WEIGHTS: Record<TaskPriority, number> = {
  critical: 1000,
  high: 100,
  normal: 10,
  low: 1,
}

const TASK_ID_PREFIXES: Record<TaskType, string> = {
  local_bash: 'b',
  local_agent: 'a',
  remote_agent: 'r',
  in_process_teammate: 't',
  local_workflow: 'w',
  monitor_mcp: 'm',
  channel_message: 'c',
  plugin_task: 'p',
  gateway_request: 'g',
  scheduled: 's',
}

const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed' || status === 'timed_out' || status === 'lost'
}

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'retrying'
}

export function isTerminalFlowStatus(status: TaskFlowStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'lost'
}

export function getTaskPriorityWeight(priority: TaskPriority): number {
  return TASK_PRIORITY_WEIGHTS[priority] ?? TASK_PRIORITY_WEIGHTS.normal
}

export function compareTaskPriority(left: TaskRecord, right: TaskRecord): number {
  const priorityDiff = getTaskPriorityWeight(right.priority) - getTaskPriorityWeight(left.priority)
  if (priorityDiff !== 0) {
    return priorityDiff
  }
  return left.createdAt - right.createdAt
}

function getTaskIdPrefix(type: TaskType): string {
  return TASK_ID_PREFIXES[type] ?? 'x'
}

export function generateTaskId(type: TaskType): string {
  const prefix = getTaskIdPrefix(type)
  const bytes = randomBytes(8)
  let id = prefix
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET.charAt(bytes[i]! % TASK_ID_ALPHABET.length)
  }
  return id
}

export function generateFlowId(): string {
  return `flow_${Date.now()}_${randomBytes(8).toString('hex').substring(0, 12)}`
}

export function generateRunId(): string {
  return `run_${Date.now()}_${randomBytes(6).toString('hex')}`
}

function getTaskOutputPath(id: string): string {
  return `.openlittletwo/tasks/${id}.log`
}

export function createTaskRecordBase(params: {
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
}): TaskRecord {
  const now = Date.now()
  const taskId = generateTaskId(params.taskKind as TaskType || 'local_bash')
  
  return {
    taskId,
    runtime: params.runtime,
    taskKind: params.taskKind,
    requesterSessionKey: params.scopeKind === 'system' ? '' : params.ownerKey,
    ownerKey: params.ownerKey,
    scopeKind: params.scopeKind ?? (params.ownerKey ? 'session' : 'system'),
    task: params.task,
    label: params.label,
    status: 'queued',
    deliveryStatus: params.ownerKey ? 'pending' : 'not_applicable',
    notifyPolicy: 'done_only',
    createdAt: now,
    lastEventAt: now,
    retryCount: 0,
    maxRetries: params.maxRetries ?? DEFAULT_TASK_CONFIG.maxRetries,
    priority: params.priority ?? 'normal',
    dependencies: params.dependencies,
    parentFlowId: params.parentFlowId,
    parentTaskId: params.parentTaskId,
    runId: params.runId ?? generateRunId(),
    childSessionKey: params.childSessionKey,
    agentId: params.agentId,
    outputFile: getTaskOutputPath(taskId),
    outputOffset: 0,
    notified: false,
    metadata: params.metadata,
  }
}

export function createTaskFlowRecord(params: {
  ownerKey: string
  goal: string
  controllerId?: string
  syncMode?: 'managed' | 'task_mirrored'
  requesterOrigin?: DeliveryContext
}): TaskFlowRecord {
  const now = Date.now()
  return {
    flowId: generateFlowId(),
    syncMode: params.syncMode ?? 'managed',
    ownerKey: params.ownerKey,
    requesterOrigin: params.requesterOrigin,
    controllerId: params.controllerId,
    revision: 0,
    status: 'queued',
    notifyPolicy: 'done_only',
    goal: params.goal,
    createdAt: now,
    updatedAt: now,
  }
}

export function normalizeTaskStatus(value: string | null | undefined): TaskStatus {
  return (value === 'running' || value === 'queued' || value === 'completed' ||
          value === 'failed' || value === 'killed' || value === 'paused' ||
          value === 'retrying' || value === 'blocked' || value === 'timed_out' ||
          value === 'lost')
    ? value as TaskStatus
    : 'queued'
}

export function normalizeTaskTerminalOutcome(
  value: string | null | undefined
): TaskTerminalOutcome | undefined {
  return value === 'succeeded' || value === 'blocked' ? value : undefined
}

export function resolveTaskTerminalOutcome(
  status: TaskStatus,
  terminalOutcome?: TaskTerminalOutcome | null
): TaskTerminalOutcome | undefined {
  if (terminalOutcome) return terminalOutcome
  return status === 'completed' ? 'succeeded' : undefined
}

export function appendTaskEvent(
  events: TaskEventRecord[],
  event: { at: number; kind: TaskStatus | 'progress'; summary?: string | null }
): TaskEventRecord[] {
  const summary = event.summary?.replace(/\s+/g, ' ').trim()
  return [...events, { at: event.at, kind: event.kind, ...(summary ? { summary } : {}) }]
}

export function calculateRetryDelay(
  retryCount: number,
  baseDelayMs: number = DEFAULT_TASK_CONFIG.defaultRetryDelayMs,
  multiplier: number = DEFAULT_TASK_CONFIG.retryBackoffMultiplier,
  maxDelayMs: number = DEFAULT_TASK_CONFIG.maxRetryDelayMs
): number {
  const delay = baseDelayMs * Math.pow(multiplier, retryCount)
  return Math.min(delay, maxDelayMs)
}

export function shouldRetryTask(task: TaskRecord): boolean {
  if (isTerminalTaskStatus(task.status)) return false
  if (task.retryCount >= task.maxRetries) return false
  return true
}

export interface TaskExecutionContext {
  abortController: AbortController
  signal: AbortSignal
  onProgress?: (progress: string) => void
  onEvent?: (event: TaskEventRecord) => void
}

export interface TaskExecutor {
  taskId: string
  run(): Promise<TaskRecord>
  kill(): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  getStatus(): TaskStatus
}

export interface AppState {
  tasks: Map<string, TaskRecord>
  flows: Map<string, TaskFlowRecord>
  config: TaskConfig & { appConfig: AppConfig }
  channels: Map<string, ChannelState>
  plugins: Map<string, PluginState>
}

export interface AppConfig {
  appName: string
  version: string
  debug: boolean
  maxConcurrentTasks: number
  taskTimeout: number
}

export interface ChannelState {
  id: string
  name: string
  type: string
  status: 'connected' | 'disconnected' | 'error'
  lastActivity?: number
}

export interface PluginState {
  id: string
  name: string
  version: string
  status: 'loaded' | 'unloaded' | 'error'
  enabled: boolean
}

export { DEFAULT_TASK_CONFIG }
