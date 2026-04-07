import { z } from 'zod'
import { buildTool, type Tool, type ToolUseContext, type PermissionResult } from '../core/Tool.js'
import fs from 'node:fs'
import path from 'node:path'

const BashToolInputSchema = z.object({
  command: z.string().describe('The shell command to execute'),
  timeout: z.number().optional().describe('Timeout in milliseconds'),
  cwd: z.string().optional().describe('Working directory'),
})

export const BashTool = buildTool({
  name: 'bash',
  description: async () => 
    'Execute a shell command and return the output. Use this for running commands, scripts, or any terminal operation.',
  inputSchema: BashToolInputSchema,
  maxResultSizeChars: 100000,

  async call(
    args: z.infer<typeof BashToolInputSchema>,
    context: ToolUseContext,
    canUseTool: () => Promise<PermissionResult>,
    _parentMessage: unknown,
  ) {
    const permission = await canUseTool()
    if (permission.behavior !== 'allow') {
      return {
        data: `Permission denied: ${permission.message ?? 'Bash execution not allowed'}`,
      }
    }

    const { execSync } = await import('node:child_process')
    
    try {
      const result = execSync(args.command, {
        cwd: args.cwd ?? process.cwd(),
        timeout: args.timeout ?? 30000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 1024 * 1024,
      })

      return {
        data: result.trim(),
      }
    } catch (error: unknown) {
      const execError = error as { stderr?: string; message?: string; status?: number }
      return {
        data: execError.stderr ?? execError.message ?? 'Command failed',
        newMessages: [{
          id: `error_${Date.now()}`,
          role: 'system' as const,
          content: `Command failed with exit code ${execError.status ?? 1}: ${args.command}`,
          timestamp: Date.now(),
        }],
      }
    }
  },

  isConcurrencySafe: (input) => !input.command.includes('&&') && !input.command.includes('||'),
  isReadOnly: (input) => {
    const readOnlyCommands = ['ls', 'cat', 'echo', 'pwd', 'which', 'find', 'grep', 'wc', 'head', 'tail']
    return readOnlyCommands.some(cmd => input.command.startsWith(cmd + ' ') || input.command === cmd)
  },
  isDestructive: (input) => {
    const destructivePatterns = ['rm -rf', 'mkfs', 'dd if=', '>', '| shred']
    return destructivePatterns.some(p => input.command.includes(p))
  },
  getPath: (input) => input.cwd,

  userFacingName: (input) => `Bash: ${input?.command ?? ''}...`,
  toAutoClassifierInput: (input) => input.command,
})

const FileReadInputSchema = z.object({
  path: z.string().describe('Path to the file to read'),
  offset: z.number().optional().describe('Line number to start reading from'),
  limit: z.number().optional().describe('Number of lines to read'),
})

export const FileReadTool = buildTool({
  name: 'read',
  aliases: ['file_read', 'cat'],
  description: async () => 
    'Read the contents of a file. Supports partial reads with offset and limit parameters.',
  inputSchema: FileReadInputSchema,
  maxResultSizeChars: Infinity,

  async call(
    args: z.infer<typeof FileReadInputSchema>,
    _context: ToolUseContext,
    _canUseTool: () => Promise<PermissionResult>,
    _parentMessage: unknown,
  ) {
    try {
      const absolutePath = path.resolve(args.path)
      
      if (!fs.existsSync(absolutePath)) {
        return { data: `Error: File not found: ${absolutePath}` }
      }

      const content = fs.readFileSync(absolutePath, 'utf-8')
      
      if (args.offset !== undefined || args.limit !== undefined) {
        const lines = content.split('\n')
        const start = (args.offset ?? 1) - 1
        const end = args.limit ? start + args.limit : undefined
        const slicedLines = lines.slice(start, end)
        return { data: slicedLines.join('\n') }
      }

      return { data: content }
    } catch (error) {
      return { data: `Error reading file: ${(error as Error).message}` }
    }
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  getPath: (input) => input.path,
  userFacingName: (input) => `Read: ${input?.path ?? ''}`,

  mapToolResultToToolResultBlockParam: (content, toolUseID) => ({
    type: 'tool_result',
    tool_use_id: toolUseID,
    content: typeof content === 'string' ? content : JSON.stringify(content),
  }),
})

const FileWriteInputSchema = z.object({
  path: z.string().describe('Path to the file to write'),
  content: z.string().describe('Content to write to the file'),
  createDirectories: z.boolean().optional().describe('Create parent directories if they do not exist'),
})

export const FileWriteTool = buildTool({
  name: 'write',
  aliases: ['file_write'],
  description: async () => 
    'Write content to a file. Creates parent directories if specified.',
  inputSchema: FileWriteInputSchema,
  maxResultSizeChars: Infinity,

  async call(
    args: z.infer<typeof FileWriteInputSchema>,
    context: ToolUseContext,
    canUseTool: () => Promise<PermissionResult>,
    _parentMessage: unknown,
  ) {
    const permission = await canUseTool()
    if (permission.behavior !== 'allow') {
      return {
        data: `Permission denied: ${permission.message ?? 'File write not allowed'}`,
      }
    }

    try {
      const absolutePath = path.resolve(args.path)

      if (args.createDirectories) {
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
      }

      fs.writeFileSync(absolutePath, args.content, 'utf-8')

      return {
        data: `Successfully wrote ${args.content.length} characters to ${absolutePath}`,
      }
    } catch (error) {
      return { data: `Error writing file: ${(error as Error).message}` }
    }
  },

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => true,
  getPath: (input) => input.path,
  userFacingName: (input) => `Write: ${input?.path ?? ''}`,
  toAutoClassifierInput: (input) => `${input.path}: write`,
})

const GrepToolInputSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for'),
  path: z.string().describe('Directory or file path to search in'),
  glob: z.string().optional().describe('Glob pattern for file filtering'),
  ignoreCase: z.boolean().optional().describe('Case-insensitive search'),
  outputMode: z.enum(['content', 'files_with_matches', 'count']).optional().describe('Output mode'),
})

export const GrepTool = buildTool({
  name: 'grep',
  aliases: ['search', 'find'],
  description: async () => 
    'Search for files matching a regex pattern. Supports glob patterns and various output modes.',
  inputSchema: GrepToolInputSchema,
  maxResultSizeChars: 50000,

  async call(
    args: z.infer<typeof GrepToolInputSchema>,
    _context: ToolUseContext,
    _canUseTool: () => Promise<PermissionResult>,
    _parentMessage: unknown,
  ) {
    // This would integrate with ripgrep or similar tool
    // For now, provide basic implementation
    return {
      data: `Search results for "${args.pattern}" in ${args.path}\n\n(Implementation would use ripgrep for performance)`,
    }
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
  userFacingName: (input) => `Search: ${input?.pattern ?? ''}`,
  toAutoClassifierInput: (input) => `grep ${input.pattern} ${input.path}`,
})

const GlobToolInputSchema = z.object({
  pattern: z.string().describe('Glob pattern to match files'),
  path: z.string().optional().describe('Base directory for search'),
  excludePatterns: z.array(z.string()).optional().describe('Patterns to exclude'),
})

export const GlobTool = buildTool({
  name: 'glob',
  aliases: ['find_files', 'list'],
  description: async () => 
    'Find files matching a glob pattern. Useful for discovering project structure.',
  inputSchema: GlobToolInputSchema,
  maxResultSizeChars: 50000,

  async call(
    args: z.infer<typeof GlobToolInputSchema>,
    _context: ToolUseContext,
    _canUseTool: () => Promise<PermissionResult>,
    _parentMessage: unknown,
  ) {
    const { glob } = await import('fast-glob')

    try {
      const options: any = {
        cwd: args.path ?? process.cwd(),
        absolute: true,
        onlyFiles: true,
        ignore: args.excludePatterns ?? [],
      }

      const files = await glob(args.pattern, options)

      return {
        data: files.length > 0 
          ? files.sort().join('\n')
          : `No files found matching: ${args.pattern}`,
      }
    } catch (error) {
      return { data: `Error searching files: ${(error as Error).message}` }
    }
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isSearchOrReadCommand: () => ({ isSearch: false, isRead: false, isList: true }),
  userFacingName: (input) => `Glob: ${input?.pattern ?? ''}`,
  toAutoClassifierInput: (input) => `glob ${input.pattern}`,
})

export const getBuiltinTools = (): Tools => [
  BashTool,
  FileReadTool,
  FileWriteTool,
  GrepTool,
  GlobTool,
]
