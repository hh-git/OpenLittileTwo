#!/usr/bin/env node

import { CLICommandRouter, createDefaultCommands, QueryEngine, StateManager, getBuiltinTools, getSystemContext, getUserContext, PluginLoader } from '../index.js'

async function main() {
  const args = process.argv.slice(2)

  // Initialize state manager
  const stateManager = StateManager.getInstance({
    appName: 'openLittleTwo',
    version: '1.0.0',
    debug: process.env.DEBUG === 'true',
  })

  // Initialize query engine with built-in tools
  const tools = getBuiltinTools()
  const queryEngine = new QueryEngine(tools)

  // Load plugins
  await PluginLoader.loadPlugins()

  // Add plugin tools to the tool set
  const pluginTools = PluginLoader.getPluginTools()
  if (pluginTools.length > 0) {
    console.log(`[CLI] Loaded ${pluginTools.length} tools from plugins`)
  }

  // Build context
  const systemContext = await getSystemContext()
  const userContext = await getUserContext(process.cwd())

  // Create CLI context
  const context = {
    state: stateManager.getState(),
    tools: [...tools, ...pluginTools],
    queryEngine,
    config: {
      version: '1.0.0',
      debug: process.env.DEBUG === 'true',
      ...systemContext,
      ...userContext,
    },
  }

  // Initialize command router
  const router = new CLICommandRouter()
  router.setContext(context)

  // Register default commands
  const defaultCommands = createDefaultCommands()
  for (const cmd of defaultCommands) {
    router.registerCommand(cmd)
  }

  // Register plugin commands
  const pluginCommands = PluginLoader.getPluginCommands()
  for (const cmd of pluginCommands) {
    router.registerCommand({
      name: cmd.name,
      description: cmd.description,
      category: 'Plugin',
      handler: async (args, ctx) => {
        await cmd.handler(args, {
          pluginId: '',
          state: ctx.state,
          tools: ctx.tools,
          getConfig: () => ({}),
          updateConfig: () => {},
        })
      },
    })
  }

  // Parse and execute
  try {
    if (args.length === 0) {
      // No arguments - show help or start interactive mode
      console.log(`
╔══════════════════════════════════════════╗
║     🤖 openLittleTwo v1.0.0              ║
║  AI-Powered Multi-Channel Gateway         ║
╚══════════════════════════════════════════╝

Usage: openlittletwo <command> [options]

Commands:
  start       Start the gateway server
  status      Show system status
  channel     Manage communication channels
  plugin      Manage plugins
  chat        Start interactive chat mode
  config      Manage configuration
  task        View and manage tasks

Run 'openlittletwo <command> --help' for more information.
`)
      process.exit(0)
    }

    await router.parse(process.argv)
  } catch (error) {
    console.error('Fatal error:', error)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error)
  process.exit(1)
})
