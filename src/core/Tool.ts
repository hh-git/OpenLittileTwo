import type { z } from 'zod'
import type { TaskContext, SetAppState, AppState } from './Task.js'

export type ToolInputJSONSchema = {
  [x: string]: unknown
  type: 'object'
  properties?: {
    [x: string]: unknown
  }
}

export type PermissionMode = 'default' | 'bypass' | 'auto' | 'plan'

export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
  | { behavior: 'ask'; message?: string }

export type ToolPermissionContext = {
  mode: PermissionMode
  alwaysAllowRules: Map<string, string[]>
  alwaysDenyRules: Map<string, string[]>
  isBypassPermissionsModeAvailable: boolean
  shouldAvoidPermissionPrompts?: boolean
}

export type ToolUseContext = {
  options: {
    debug: boolean
    verbose: boolean
    tools: Tools
    maxBudgetUsd?: number
  }
  abortController: AbortController
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  setAppStateForTasks?: (f: (prev: AppState) => AppState) => void
  messages: unknown[]
  toolDecisions?: Map<
    string,
    {
      source: string
      decision: 'accept' | 'reject'
      timestamp: number
    }
  >
}

export type ValidationResult =
  | { result: true }
  | {
      result: false
      message: string
      errorCode: number
    }

export type ToolResult<T> = {
  data: T
  newMessages?: unknown[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
}

export type ToolCallProgress<P> = (progress: P) => void

export type AnyObject = z.ZodType<{ [key: string]: unknown }>

export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}

export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(t => toolMatchesName(t, name))
}

export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P = unknown,
> = {
  aliases?: string[]
  searchHint?: string
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    canUseTool: () => Promise<PermissionResult>,
    parentMessage: unknown,
    onProgress?: ToolCallProgress<P>,
  ): Promise<ToolResult<Output>>
  description(
    input: z.infer<Input>,
    options: {
      toolPermissionContext: ToolPermissionContext
      tools: Tools
    },
  ): Promise<string>
  readonly inputSchema: Input
  readonly inputJSONSchema?: ToolInputJSONSchema
  outputSchema?: z.ZodType<unknown>
  inputsEquivalent?(a: z.infer<Input>, b: z.infer<Input>): boolean
  isConcurrencySafe(input: z.infer<Input>): boolean
  isEnabled(): boolean
  isReadOnly(input: z.infer<Input>): boolean
  isDestructive?(input: z.infer<Input>): boolean
  interruptBehavior?(): 'cancel' | 'block'
  requiresUserInteraction?(): boolean
  readonly shouldDefer?: boolean
  readonly alwaysLoad?: boolean
  readonly name: string
  maxResultSizeChars: number
  validateInput?(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ValidationResult>
  checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionResult>
  getPath?(input: z.infer<Input>): string
  prompt(options: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: Tools
  }): Promise<string>
  userFacingName(input: Partial<z.infer<Input>> | undefined): string
  toAutoClassifierInput(input: z.infer<Input>): unknown
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): unknown
}

export type Tools = readonly Tool[]

type DefaultableToolKeys =
  | 'isEnabled'
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'isDestructive'
  | 'checkPermissions'
  | 'toAutoClassifierInput'
  | 'userFacingName'

export type ToolDef<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P = unknown,
> = Omit<Tool<Input, Output, P>, DefaultableToolKeys> &
  Partial<Pick<Tool<Input, Output, P>, DefaultableToolKeys>>

type BuiltTool<D> = Omit<D, DefaultableToolKeys> & {
  [K in DefaultableToolKeys]-?: K extends keyof D
    ? undefined extends D[K]
      ? ToolDefaults[K]
      : D[K]
    : ToolDefaults[K]
}

const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (
    input: { [key: string]: unknown },
    _ctx?: ToolUseContext,
  ): Promise<PermissionResult> =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown, _tool?: Tool) => '',
} as const

type ToolDefaults = typeof TOOL_DEFAULTS

type AnyToolDef = ToolDef<any, any, any>

export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: (input?: unknown) => def.name,
    ...def,
  } as BuiltTool<D>
}
