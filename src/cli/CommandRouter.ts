import { Command } from 'commander'
import chalk from 'chalk'
import type { Tool, Tools, ToolUseContext, PermissionResult } from '../core/Tool.js'
import type { QueryEngine, QueryParams, QuerySource } from '../core/QueryEngine.js'
import type { AppState } from '../core/Task.js'

export interface CLIContext {
  state: AppState
  tools: Tools
  queryEngine: QueryEngine
  config: Record<string, unknown>
}

export interface CommandDefinition {
  name: string
  description: string
  aliases?: string[]
  category?: string
  options?: CommandOption[]
  handler: (args: Record<string, unknown>, context: CLIContext) => Promise<void>
}

export interface CommandOption {
  flags: string
  description: string
  required?: boolean
  defaultValue?: unknown
}

export class CLICommandRouter {
  private program: Command
  private commands: Map<string, CommandDefinition> = new Map()
  private context?: CLIContext

  constructor() {
    this.program = new Command()
      .name('openlittletwo')
      .description('AI-powered multi-channel gateway')
      .version('1.0.0')
  }

  setContext(context: CLIContext): void {
    this.context = context
  }

  registerCommand(definition: CommandDefinition): void {
    this.commands.set(definition.name, definition)

    const command = this.program
      .command(definition.name)
      .description(definition.description)

    if (definition.aliases && definition.aliases.length > 0) {
      command.alias(definition.aliases[0])
    }

    if (definition.options) {
      for (const option of definition.options) {
        if (option.defaultValue !== undefined) {
          command.option(option.flags, option.description, option.defaultValue as string | boolean | string[] | undefined)
        } else {
          command.option(option.flags, option.description)
        }
      }
    }

    command.action(async (args) => {
      if (!this.context) {
        console.error(chalk.red('Error: CLI context not initialized'))
        process.exit(1)
      }

      try {
        await definition.handler(args as Record<string, unknown>, this.context)
      } catch (error) {
        console.error(
          chalk.red(`Error executing command "${definition.name}":`),
          error,
        )
        process.exit(1)
      }
    })
  }

  getCommand(name: string): CommandDefinition | undefined {
    return this.commands.get(name)
  }

  getAllCommands(): CommandDefinition[] {
    return Array.from(this.commands.values())
  }

  getCommandsByCategory(category: string): CommandDefinition[] {
    return this.getAllCommands().filter(cmd => cmd.category === category)
  }

  async parse(argv: string[]): Promise<void> {
    await this.program.parseAsync(argv)
  }

  printHelp(): void {
    this.program.outputHelp()
  }
}

export const createDefaultCommands = (): CommandDefinition[] => [
  {
    name: 'start',
    description: 'Start the openLittleTwo gateway server',
    category: 'Server',
    options: [
      { flags: '-p, --port <number>', description: 'Port number', defaultValue: 8080 },
      { flags: '--host <string>', description: 'Host address', defaultValue: '0.0.0.0' },
      { flags: '--debug', description: 'Enable debug mode' },
    ],
    handler: async (args, context) => {
      const { GatewayServer } = await import('../gateway/GatewayServer.js')
      
      console.log(chalk.blue('Starting openLittleTwo gateway...'))
      
      const gateway = new GatewayServer({
        port: args.port as number,
        host: args.host as string,
      })

      await gateway.start()

      console.log(chalk.green(`✓ Gateway running on port ${args.port}`))
      console.log(chalk.gray('Press Ctrl+C to stop'))

      // Graceful shutdown
      process.on('SIGINT', async () => {
        console.log(chalk.yellow('\nShutting down...'))
        await gateway.stop()
        process.exit(0)
      })
    },
  },

  {
    name: 'status',
    description: 'Show system status and information',
    category: 'System',
    handler: async (_args, context) => {
      console.log(chalk.bold('\n📊 openLittleTwo Status\n'))
      console.log(`Version: ${context.config.version ?? '1.0.0'}`)
      console.log(`State: ${chalk.green('Running')}`)
      console.log(`Tasks: ${context.state.tasks.size}`)
      console.log(`Channels: ${context.state.channels.size}`)
      console.log(`Plugins: ${context.state.plugins.size}`)
    },
  },

  {
    name: 'channel',
    description: 'Manage communication channels (list|connect|disconnect|status)',
    category: 'Channels',
    aliases: ['ch'],
    handler: async (args, _context) => {
      const cmdArgs = args.args as string[] | undefined
      const action = cmdArgs?.[0]

      switch (action) {
        case 'list':
          console.log(chalk.blue('\n📡 Available Channels\n'))
          break
        case 'status':
          console.log(chalk.blue('\n📡 Channel Status\n'))
          break
        default:
          console.log(chalk.yellow('Usage: channel <list|connect|disconnect|status> [id]'))
      }
    },
  },

  {
    name: 'plugin',
    description: 'Manage plugins (list|enable|disable|reload)',
    category: 'Plugins',
    aliases: ['pl'],
    handler: async (args, context) => {
      const cmdArgs = args.args as string[] | undefined
      const action = cmdArgs?.[0]
      const pluginName = cmdArgs?.[1]

      switch (action) {
        case 'list':
          console.log(chalk.blue('\n🔌 Installed Plugins\n'))
          for (const [id, plugin] of context.state.plugins) {
            const status = plugin.enabled ? chalk.green('●') : chalk.red('○')
            console.log(`${status} ${id}: ${plugin.name} v${plugin.version}`)
          }
          break
        case 'enable':
          if (!pluginName) {
            console.error(chalk.red('Plugin name required'))
            return
          }
          console.log(chalk.green(`Enabling plugin: ${pluginName}`))
          break
        case 'disable':
          if (!pluginName) {
            console.error(chalk.red('Plugin name required'))
            return
          }
          console.log(chalk.yellow(`Disabling plugin: ${pluginName}`))
          break
        default:
          console.log(chalk.yellow('Usage: plugin <list|enable|disable|reload> [name]'))
      }
    },
  },

  {
    name: 'chat',
    description: 'Start interactive chat mode',
    category: 'Interactive',
    aliases: ['c'],
    options: [
      { flags: '-c, --channel <string>', description: 'Channel to use' },
      { flags: '-m, --model <string>', description: 'AI model to use' },
    ],
    handler: async (args, context) => {
      console.log(chalk.cyan('\n💬 Interactive Chat Mode\n'))
      console.log(chalk.gray('Type your message and press Enter. Type "exit" to quit.\n'))

      const queryEngine = context.queryEngine

      // Simple REPL loop
      process.stdout.write(chalk.green('> '))
      
      process.stdin.on('data', async (data) => {
        const input = data.toString().trim()

        if (input.toLowerCase() === 'exit') {
          console.log(chalk.yellow('Goodbye!'))
          process.exit(0)
        }

        if (input) {
          try {
            const result = await queryEngine.execute({
              messages: [{
                id: `msg_${Date.now()}`,
                role: 'user',
                content: input,
                timestamp: Date.now(),
              }],
              systemPrompt: 'You are a helpful AI assistant.',
              userContext: {},
              systemContext: {},
              canUseTool: () => Promise.resolve({ behavior: 'allow', updatedInput: {} }),
              toolUseContext: {
                options: { debug: false, verbose: false, tools: context.tools },
                abortController: new AbortController(),
                getAppState: () => context.state,
                setAppState: () => {},
                messages: [],
              },
              querySource: 'cli',
            })

            if (result.success && result.response) {
              console.log(chalk.white(result.response))
            }
          } catch (error) {
            console.error(chalk.red('Error:'), error)
          }
        }

        process.stdout.write(chalk.green('> '))
      })
    },
  },

  {
    name: 'config',
    description: 'Manage configuration (get|set|list|reset)',
    category: 'System',
    aliases: ['cfg'],
    handler: async (args, context) => {
      const cmdArgs = args.args as string[] | undefined
      const action = cmdArgs?.[0]
      const key = cmdArgs?.[1]
      const value = cmdArgs?.[2]

      switch (action) {
        case 'get':
          if (key) {
            console.log(`${key}:`, (context.config as any)[key])
          }
          break
        case 'set':
          if (key && value !== undefined) {
            ;(context.config as any)[key] = value
            console.log(chalk.green(`Set ${key} = ${value}`))
          }
          break
        case 'list':
          console.log(chalk.blue('\n⚙️ Configuration\n'))
          console.log(JSON.stringify(context.config, null, 2))
          break
        default:
          console.log(chalk.yellow('Usage: config <get|set|list|reset> [key] [value]'))
      }
    },
  },

  {
    name: 'task',
    description: 'View and manage tasks',
    category: 'System',
    aliases: ['t'],
    options: [
      { flags: '--all', description: 'Show all tasks including completed' },
      { flags: '--running', description: 'Show only running tasks' },
    ],
    handler: async (args, context) => {
      const cmdArgs = args.args as string[] | undefined
      const taskId = cmdArgs?.[0]
      const showAll = args.all as boolean | undefined
      const showRunning = args.running as boolean | undefined

      console.log(chalk.blue('\n📋 Tasks\n'))

      let tasks = Array.from(context.state.tasks.values())

      if (showRunning) {
        tasks = tasks.filter(t => t.status === 'running')
      } else if (!showAll) {
        tasks = tasks.filter(t => !isTerminalTaskStatus(t.status))
      }

      if (taskId) {
        const task = context.state.tasks.get(taskId)
        if (task) {
          console.log(`ID: ${task.taskId}`)
          console.log(`Kind: ${task.taskKind ?? task.runtime}`)
          console.log(`Status: ${task.status}`)
          console.log(`Task: ${task.task}`)
          if (task.startedAt) {
            console.log(`Started: ${new Date(task.startedAt).toLocaleString()}`)
          }
        } else {
          console.log(chalk.red(`Task ${taskId} not found`))
        }
      } else {
        if (tasks.length === 0) {
          console.log(chalk.gray('No tasks found'))
        } else {
          for (const task of tasks) {
            const statusColor = task.status === 'completed'
              ? chalk.green
              : task.status === 'failed' || task.status === 'killed'
                ? chalk.red
                : chalk.yellow

            console.log(`${statusColor(task.status)} ${task.taskId}: ${task.task}`)
          }
        }
      }
    },
  },
]

function isTerminalTaskStatus(status: string): boolean {
  return ['completed', 'failed', 'killed'].includes(status)
}
