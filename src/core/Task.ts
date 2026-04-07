import { randomBytes } from 'crypto'

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

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'paused'
  | 'retrying'

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

export type TaskPriority = 'low' | 'normal' | 'high' | 'critical'

export type TaskHandle = {
  taskId: string
  cleanup?: () => void
}

export type SetAppState = (f: (prev: AppState) => AppState) => void

export type TaskContext = {
  abortController: AbortController
  getAppState: () => AppState
  setAppState: SetAppState
}

export type TaskStateBase = {
  id: string
  type: TaskType
  status: TaskStatus
  priority: TaskPriority
  description: string
  toolUseId?: string
  startTime: number
  endTime?: number
  totalPausedMs?: number
  retryCount?: number
  maxRetries?: number
  outputFile: string
  outputOffset: number
  notified: boolean
  metadata?: Record<string, unknown>
}

const TASK_ID_PREFIXES: Record<string, string> = {
  local_bash: 'b',
  local_agent: 'a',
  remote_agent: 'r',
  in_process_teammate: 't',
  local_workflow: 'w',
  monitor_mcp: 'm',
  channel_message: 'c',
  plugin_task: 'p',
  gateway_request: 'g',
}

const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function getTaskIdPrefix(type: TaskType): string {
  return TASK_ID_PREFIXES[type] ?? 'x'
}

export function generateTaskId(type: TaskType): string {
  const prefix = getTaskIdPrefix(type)
  const bytes = randomBytes(8)
  let id = prefix
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length]
  }
  return id
}

export function createTaskStateBase(
  id: string,
  type: TaskType,
  description: string,
  priority: TaskPriority = 'normal',
  toolUseId?: string,
): TaskStateBase {
  return {
    id,
    type,
    status: 'pending',
    priority,
    description,
    toolUseId,
    startTime: Date.now(),
    outputFile: getTaskOutputPath(id),
    outputOffset: 0,
    notified: false,
  }
}

function getTaskOutputPath(id: string): string {
  return `.openlittletwo/tasks/${id}.log`
}

export type Task = {
  name: string
  type: TaskType
  kill(taskId: string, setAppState: SetAppState): Promise<void>
  pause?(taskId: string, setAppState: SetAppState): Promise<void>
  resume?(taskId: string, setAppState: SetAppState): Promise<void>
}

export interface AppState {
  tasks: Map<string, TaskStateBase>
  config: AppConfig
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
