import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { TaskRecord, TaskFlowRecord, TaskDeliveryStatus } from './Task.js'

export interface TaskDeliveryState {
  taskId: string
  requesterOrigin?: {
    channel?: string
    to?: string
    accountId?: string
    threadId?: string | number
  }
  lastNotifiedEventAt?: number
}

export interface TaskRegistryStoreSnapshot {
  tasks: Map<string, TaskRecord>
  flows: Map<string, TaskFlowRecord>
  deliveryStates?: Map<string, TaskDeliveryState>
}

type TaskRegistryRow = {
  task_id: string
  runtime: string
  source_id: string | null
  owner_key: string
  scope_kind: string
  child_session_key: string | null
  parent_flow_id: string | null
  parent_task_id: string | null
  agent_id: string | null
  run_id: string | null
  label: string | null
  task: string
  status: string
  delivery_status: string
  notify_policy: string
  created_at: number | bigint
  started_at: number | bigint | null
  ended_at: number | bigint | null
  last_event_at: number | bigint | null
  cleanup_after: number | bigint | null
  error: string | null
  progress_summary: string | null
  terminal_summary: string | null
  terminal_outcome: string | null
}

type TaskDeliveryStateRow = {
  task_id: string
  requester_origin_json: string | null
  last_notified_event_at: number | bigint | null
}

type TaskRegistryStatements = {
  selectAllTasks: StatementSync
  selectAllFlows: StatementSync
  selectAllDeliveryStates: StatementSync
  upsertTask: StatementSync
  upsertFlow: StatementSync
  replaceDeliveryState: StatementSync
  deleteTask: StatementSync
  deleteFlow: StatementSync
  deleteDeliveryState: StatementSync
  clearTasks: StatementSync
  clearFlows: StatementSync
  clearDeliveryStates: StatementSync
}

type TaskRegistryDatabase = {
  db: DatabaseSync
  path: string
  statements: TaskRegistryStatements
}

let cachedDatabase: TaskRegistryDatabase | null = null

const DB_DIR_MODE = 0o700
const DB_FILE_MODE = 0o600

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === 'bigint') return Number(value)
  return typeof value === 'number' ? value : undefined
}

function serializeJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value)
}

function parseJsonValue<T>(raw: string | null): T | undefined {
  if (!raw?.trim()) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

function rowToTaskRecord(row: TaskRegistryRow): TaskRecord {
  const startedAt = normalizeNumber(row.started_at)
  const endedAt = normalizeNumber(row.ended_at)
  const lastEventAt = normalizeNumber(row.last_event_at)
  const cleanupAfter = normalizeNumber(row.cleanup_after)
  const createdAt = normalizeNumber(row.created_at)

  const record: TaskRecord = {
    taskId: row.task_id,
    runtime: row.runtime as TaskRecord['runtime'],
    requesterSessionKey: row.scope_kind === 'system' ? '' : row.owner_key,
    ownerKey: row.owner_key,
    scopeKind: row.scope_kind as TaskRecord['scopeKind'],
    task: row.task,
    status: row.status as TaskRecord['status'],
    deliveryStatus: row.delivery_status as TaskDeliveryStatus,
    notifyPolicy: row.notify_policy as TaskRecord['notifyPolicy'],
    createdAt: createdAt ?? 0,
    lastEventAt: lastEventAt ?? createdAt ?? 0,
    retryCount: 0,
    maxRetries: 3,
    priority: 'normal',
    outputFile: `.openlittletwo/tasks/${row.task_id}.log`,
    outputOffset: 0,
    notified: false,
  }

  if (row.source_id) record.sourceId = row.source_id
  if (row.child_session_key) record.childSessionKey = row.child_session_key
  if (row.parent_flow_id) record.parentFlowId = row.parent_flow_id
  if (row.parent_task_id) record.parentTaskId = row.parent_task_id
  if (row.agent_id) record.agentId = row.agent_id
  if (row.run_id) record.runId = row.run_id
  if (row.label) record.label = row.label
  if (startedAt != null) record.startedAt = startedAt
  if (endedAt != null) record.endedAt = endedAt
  if (cleanupAfter != null) record.cleanupAfter = cleanupAfter
  if (row.error) record.error = row.error
  if (row.progress_summary) record.progressSummary = row.progress_summary
  if (row.terminal_summary) record.terminalSummary = row.terminal_summary
  if (row.terminal_outcome) record.terminalOutcome = row.terminal_outcome as TaskRecord['terminalOutcome']

  return record
}

function rowToTaskFlowRecord(row: TaskFlowRow): TaskFlowRecord {
  return {
    flowId: row.flow_id,
    syncMode: row.sync_mode as 'managed' | 'task_mirrored',
    ownerKey: row.owner_key,
    ...(row.controller_id ? { controllerId: row.controller_id } : {}),
    revision: Number(row.revision),
    status: row.status as TaskFlowRecord['status'],
    notifyPolicy: row.notify_policy as TaskRecord['notifyPolicy'],
    goal: row.goal,
    ...(row.current_step ? { currentStep: row.current_step } : {}),
    ...(row.blocked_task_id ? { blockedTaskId: row.blocked_task_id } : {}),
    ...(row.blocked_summary ? { blockedSummary: row.blocked_summary } : {}),
    ...(row.state_json ? { stateJson: parseJsonValue(row.state_json) } : {}),
    ...(row.wait_json ? { waitJson: parseJsonValue(row.wait_json) } : {}),
    ...(row.cancel_requested_at ? { cancelRequestedAt: Number(row.cancel_requested_at) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.ended_at ? { endedAt: Number(row.ended_at) } : {}),
  }
}

function rowToTaskDeliveryState(row: TaskDeliveryStateRow): TaskDeliveryState {
  const requesterOrigin = parseJsonValue<TaskDeliveryState['requesterOrigin']>(row.requester_origin_json)
  const lastNotifiedEventAt = normalizeNumber(row.last_notified_event_at)
  return {
    taskId: row.task_id,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    ...(lastNotifiedEventAt != null ? { lastNotifiedEventAt } : {}),
  }
}

type TaskFlowRow = {
  flow_id: string
  sync_mode: string
  owner_key: string
  controller_id: string | null
  revision: number
  status: string
  notify_policy: string
  goal: string
  current_step: string | null
  blocked_task_id: string | null
  blocked_summary: string | null
  state_json: string | null
  wait_json: string | null
  cancel_requested_at: number | null
  created_at: number
  updated_at: number
  ended_at: number | null
}

function bindTaskRecord(record: TaskRecord) {
  return {
    task_id: record.taskId,
    runtime: record.runtime,
    source_id: record.sourceId ?? null,
    owner_key: record.ownerKey,
    scope_kind: record.scopeKind,
    child_session_key: record.childSessionKey ?? null,
    parent_flow_id: record.parentFlowId ?? null,
    parent_task_id: record.parentTaskId ?? null,
    agent_id: record.agentId ?? null,
    run_id: record.runId ?? null,
    label: record.label ?? null,
    task: record.task,
    status: record.status,
    delivery_status: record.deliveryStatus,
    notify_policy: record.notifyPolicy,
    created_at: record.createdAt,
    started_at: record.startedAt ?? null,
    ended_at: record.endedAt ?? null,
    last_event_at: record.lastEventAt ?? null,
    cleanup_after: record.cleanupAfter ?? null,
    error: record.error ?? null,
    progress_summary: record.progressSummary ?? null,
    terminal_summary: record.terminalSummary ?? null,
    terminal_outcome: record.terminalOutcome ?? null,
  }
}

function bindFlowRecord(record: TaskFlowRecord) {
  return {
    flow_id: record.flowId,
    sync_mode: record.syncMode,
    owner_key: record.ownerKey,
    controller_id: record.controllerId ?? null,
    revision: record.revision,
    status: record.status,
    notify_policy: record.notifyPolicy,
    goal: record.goal,
    current_step: record.currentStep ?? null,
    blocked_task_id: record.blockedTaskId ?? null,
    blocked_summary: record.blockedSummary ?? null,
    state_json: record.stateJson != null ? JSON.stringify(record.stateJson) : null,
    wait_json: record.waitJson != null ? JSON.stringify(record.waitJson) : null,
    cancel_requested_at: record.cancelRequestedAt ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    ended_at: record.endedAt ?? null,
  }
}

function bindTaskDeliveryState(state: TaskDeliveryState) {
  return {
    task_id: state.taskId,
    requester_origin_json: serializeJson(state.requesterOrigin),
    last_notified_event_at: state.lastNotifiedEventAt ?? null,
  }
}

function hasTableColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[]
  return rows.some(row => row.name === columnName)
}

function createStatements(db: DatabaseSync): TaskRegistryStatements {
  return {
    selectAllTasks: db.prepare(`
      SELECT
        task_id, runtime, source_id, owner_key, scope_kind,
        child_session_key, parent_flow_id, parent_task_id,
        agent_id, run_id, label, task, status, delivery_status,
        notify_policy, created_at, started_at, ended_at,
        last_event_at, cleanup_after, error, progress_summary,
        terminal_summary, terminal_outcome
      FROM task_runs
      ORDER BY created_at ASC, task_id ASC
    `),
    selectAllFlows: db.prepare(`
      SELECT
        flow_id, sync_mode, owner_key, controller_id, revision,
        status, notify_policy, goal, current_step, blocked_task_id,
        blocked_summary, state_json, wait_json, cancel_requested_at,
        created_at, updated_at, ended_at
      FROM task_flows
      ORDER BY created_at ASC, flow_id ASC
    `),
    selectAllDeliveryStates: db.prepare(`
      SELECT task_id, requester_origin_json, last_notified_event_at
      FROM task_delivery_state
      ORDER BY task_id ASC
    `),
    upsertTask: db.prepare(`
      INSERT INTO task_runs (
        task_id, runtime, source_id, owner_key, scope_kind,
        child_session_key, parent_flow_id, parent_task_id,
        agent_id, run_id, label, task, status, delivery_status,
        notify_policy, created_at, started_at, ended_at,
        last_event_at, cleanup_after, error, progress_summary,
        terminal_summary, terminal_outcome
      ) VALUES (
        @task_id, @runtime, @source_id, @owner_key, @scope_kind,
        @child_session_key, @parent_flow_id, @parent_task_id,
        @agent_id, @run_id, @label, @task, @status, @delivery_status,
        @notify_policy, @created_at, @started_at, @ended_at,
        @last_event_at, @cleanup_after, @error, @progress_summary,
        @terminal_summary, @terminal_outcome
      )
      ON CONFLICT(task_id) DO UPDATE SET
        runtime = excluded.runtime,
        source_id = excluded.source_id,
        owner_key = excluded.owner_key,
        scope_kind = excluded.scope_kind,
        child_session_key = excluded.child_session_key,
        parent_flow_id = excluded.parent_flow_id,
        parent_task_id = excluded.parent_task_id,
        agent_id = excluded.agent_id,
        run_id = excluded.run_id,
        label = excluded.label,
        task = excluded.task,
        status = excluded.status,
        delivery_status = excluded.delivery_status,
        notify_policy = excluded.notify_policy,
        created_at = excluded.created_at,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        last_event_at = excluded.last_event_at,
        cleanup_after = excluded.cleanup_after,
        error = excluded.error,
        progress_summary = excluded.progress_summary,
        terminal_summary = excluded.terminal_summary,
        terminal_outcome = excluded.terminal_outcome
    `),
    upsertFlow: db.prepare(`
      INSERT INTO task_flows (
        flow_id, sync_mode, owner_key, controller_id, revision,
        status, notify_policy, goal, current_step, blocked_task_id,
        blocked_summary, state_json, wait_json, cancel_requested_at,
        created_at, updated_at, ended_at
      ) VALUES (
        @flow_id, @sync_mode, @owner_key, @controller_id, @revision,
        @status, @notify_policy, @goal, @current_step, @blocked_task_id,
        @blocked_summary, @state_json, @wait_json, @cancel_requested_at,
        @created_at, @updated_at, @ended_at
      )
      ON CONFLICT(flow_id) DO UPDATE SET
        sync_mode = excluded.sync_mode,
        owner_key = excluded.owner_key,
        controller_id = excluded.controller_id,
        revision = excluded.revision,
        status = excluded.status,
        notify_policy = excluded.notify_policy,
        goal = excluded.goal,
        current_step = excluded.current_step,
        blocked_task_id = excluded.blocked_task_id,
        blocked_summary = excluded.blocked_summary,
        state_json = excluded.state_json,
        wait_json = excluded.wait_json,
        cancel_requested_at = excluded.cancel_requested_at,
        updated_at = excluded.updated_at,
        ended_at = excluded.ended_at
    `),
    replaceDeliveryState: db.prepare(`
      INSERT OR REPLACE INTO task_delivery_state (
        task_id, requester_origin_json, last_notified_event_at
      ) VALUES (@task_id, @requester_origin_json, @last_notified_event_at)
    `),
    deleteTask: db.prepare(`DELETE FROM task_runs WHERE task_id = ?`),
    deleteFlow: db.prepare(`DELETE FROM task_flows WHERE flow_id = ?`),
    deleteDeliveryState: db.prepare(`DELETE FROM task_delivery_state WHERE task_id = ?`),
    clearTasks: db.prepare(`DELETE FROM task_runs`),
    clearFlows: db.prepare(`DELETE FROM task_flows`),
    clearDeliveryStates: db.prepare(`DELETE FROM task_delivery_state`),
  }
}

function ensureSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_runs (
      task_id TEXT PRIMARY KEY,
      runtime TEXT NOT NULL,
      source_id TEXT,
      owner_key TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      child_session_key TEXT,
      parent_flow_id TEXT,
      parent_task_id TEXT,
      agent_id TEXT,
      run_id TEXT,
      label TEXT,
      task TEXT NOT NULL,
      status TEXT NOT NULL,
      delivery_status TEXT NOT NULL,
      notify_policy TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      last_event_at INTEGER,
      cleanup_after INTEGER,
      error TEXT,
      progress_summary TEXT,
      terminal_summary TEXT,
      terminal_outcome TEXT
    )
  `)

  if (!hasTableColumn(db, 'task_runs', 'parent_flow_id')) {
    db.exec(`ALTER TABLE task_runs ADD COLUMN parent_flow_id TEXT`)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_flows (
      flow_id TEXT PRIMARY KEY,
      sync_mode TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      controller_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      notify_policy TEXT NOT NULL,
      goal TEXT NOT NULL,
      current_step TEXT,
      blocked_task_id TEXT,
      blocked_summary TEXT,
      state_json TEXT,
      wait_json TEXT,
      cancel_requested_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_delivery_state (
      task_id TEXT PRIMARY KEY,
      requester_origin_json TEXT,
      last_notified_event_at INTEGER
    )
  `)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_run_id ON task_runs(run_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_owner_key ON task_runs(owner_key)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_parent_flow_id ON task_runs(parent_flow_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_cleanup_after ON task_runs(cleanup_after)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_flows_status ON task_flows(status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_flows_owner_key ON task_flows(owner_key)`)
}

function ensurePermissions(pathname: string) {
  const dir = path.dirname(pathname)
  mkdirSync(dir, { recursive: true, mode: DB_DIR_MODE })
  chmodSync(dir, DB_DIR_MODE)
  for (const suffix of ['', '-shm', '-wal']) {
    const candidate = `${pathname}${suffix}`
    if (existsSync(candidate)) {
      chmodSync(candidate, DB_FILE_MODE)
    }
  }
}

function openDatabase(dbPath?: string): TaskRegistryDatabase {
  const pathname = dbPath ?? path.join('.openlittletwo', 'task-registry.db')

  if (cachedDatabase && cachedDatabase.path === pathname) {
    return cachedDatabase
  }

  if (cachedDatabase) {
    cachedDatabase.db.close()
    cachedDatabase = null
  }

  ensurePermissions(pathname)

  let DatabaseSyncClass: typeof import('node:sqlite').DatabaseSync
  try {
    DatabaseSyncClass = require('node:sqlite').DatabaseSync
  } catch {
    throw new Error(
      'SQLite support requires Node.js 22+ with --experimental-sqlite flag, ' +
      'or the node:sqlite module. Use JSON file storage as fallback.'
    )
  }

  const db = new DatabaseSyncClass(pathname)
  db.exec(`PRAGMA journal_mode = WAL`)
  db.exec(`PRAGMA synchronous = NORMAL`)
  db.exec(`PRAGMA busy_timeout = 5000`)

  ensureSchema(db)
  ensurePermissions(pathname)

  cachedDatabase = {
    db,
    path: pathname,
    statements: createStatements(db),
  }

  return cachedDatabase
}

function withWriteTransaction<T>(fn: (statements: TaskRegistryStatements) => T): T {
  const store = openDatabase()
  store.db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn(store.statements)
    store.db.exec('COMMIT')
    ensurePermissions(store.path)
    return result
  } catch (error) {
    store.db.exec('ROLLBACK')
    throw error
  }
}

export function loadTaskRegistrySnapshot(): TaskRegistryStoreSnapshot {
  const store = openDatabase()

  const taskRows = store.statements.selectAllTasks.all() as TaskRegistryRow[]
  const flowRows = store.statements.selectAllFlows.all() as TaskFlowRow[]
  const deliveryRows = store.statements.selectAllDeliveryStates.all() as TaskDeliveryStateRow[]

  return {
    tasks: new Map(taskRows.map(row => [row.task_id, rowToTaskRecord(row)])),
    flows: new Map(flowRows.map(row => [row.flow_id, rowToTaskFlowRecord(row)])),
    deliveryStates: new Map(deliveryRows.map(row => [row.task_id, rowToTaskDeliveryState(row)])),
  }
}

export function saveTaskRegistrySnapshot(snapshot: TaskRegistryStoreSnapshot) {
  withWriteTransaction(statements => {
    statements.clearTasks.run()
    statements.clearFlows.run()
    statements.clearDeliveryStates.run()

    for (const task of snapshot.tasks.values()) {
      statements.upsertTask.run(bindTaskRecord(task))
    }
    for (const flow of snapshot.flows.values()) {
      statements.upsertFlow.run(bindFlowRecord(flow))
    }
    if (snapshot.deliveryStates) {
      for (const state of snapshot.deliveryStates.values()) {
        statements.replaceDeliveryState.run(bindTaskDeliveryState(state))
      }
    }
  })
}

export function upsertTaskToStorage(task: TaskRecord) {
  const store = openDatabase()
  store.statements.upsertTask.run(bindTaskRecord(task))
}

export function upsertFlowToStorage(flow: TaskFlowRecord) {
  const store = openDatabase()
  store.statements.upsertFlow.run(bindFlowRecord(flow))
}

export function upsertDeliveryStateToStorage(state: TaskDeliveryState) {
  const store = openDatabase()
  store.statements.replaceDeliveryState.run(bindTaskDeliveryState(state))
}

export function deleteTaskFromStorage(taskId: string) {
  const store = openDatabase()
  store.statements.deleteTask.run(taskId)
  store.statements.deleteDeliveryState.run(taskId)
}

export function deleteFlowFromStorage(flowId: string) {
  const store = openDatabase()
  store.statements.deleteFlow.run(flowId)
}

export function deleteDeliveryStateFromStorage(taskId: string) {
  const store = openDatabase()
  store.statements.deleteDeliveryState.run(taskId)
}

export function closeStorage() {
  if (cachedDatabase) {
    cachedDatabase.db.close()
    cachedDatabase = null
  }
}

export function setStoragePath(dbPath: string) {
  if (cachedDatabase) {
    cachedDatabase.db.close()
    cachedDatabase = null
  }
  openDatabase(dbPath)
}
