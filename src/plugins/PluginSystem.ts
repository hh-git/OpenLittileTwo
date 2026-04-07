import { createHash } from 'crypto'
import { createJiti } from 'jiti'
import path from 'node:path'
import fs from 'node:fs'
import type { Tool, Tools, ToolUseContext } from '../core/Tool.js'
import type { TaskType, TaskStateBase, AppState } from '../core/Task.js'

export interface PluginManifest {
  name: string
  version: string
  description: string
  author?: string
  license?: string
  main: string
  permissions?: string[]
  dependencies?: string[]
  configSchema?: Record<string, unknown>
}

export interface PluginDefinition {
  id: string
  manifest: PluginManifest
  rootPath: string
  status: 'loaded' | 'unloaded' | 'error'
  enabled: boolean
  instance?: PluginInstance
  error?: Error
}

export interface PluginInstance {
  tools?: Tools
  channels?: unknown[]
  commands?: CommandDefinition[]
  hooks?: PluginHooks
  config?: Record<string, unknown>
}

export interface CommandDefinition {
  name: string
  description: string
  handler: (args: Record<string, unknown>, context: PluginContext) => Promise<unknown>
  parameters?: Record<string, { type: string; required: boolean; description: string }>
}

export interface PluginHooks {
  onMessage?(message: unknown, context: PluginContext): Promise<unknown | void>
  onToolCall?(toolName: string, input: Record<string, unknown>, context: PluginContext): Promise<void>
  beforeResponse?(response: string, context: PluginContext): Promise<string>
  afterResponse?(response: string, context: PluginContext): Promise<void>
  onError?(error: Error, context: PluginContext): Promise<void>
}

export interface PluginContext {
  pluginId: string
  state: AppState
  tools: Tools
  sendMessage?: (channelId: string, userId: string, content: string) => Promise<void>
  getConfig: () => Record<string, unknown>
  updateConfig: (config: Record<string, unknown>) => void
}

export interface PluginLoadOptions {
  pluginDirs?: string[]
  enabledPlugins?: string[]
  disabledPlugins?: string[]
  configOverrides?: Map<string, Record<string, unknown>>
}

class PluginLoaderImpl {
  private plugins: Map<string, PluginDefinition> = new Map()
  private toolRegistry: Map<string, { tool: Tool; pluginId: string }> = new Map()
  private commandRegistry: Map<string, { command: CommandDefinition; pluginId: string }> = new Map()

  async loadPlugins(options?: PluginLoadOptions): Promise<Map<string, PluginDefinition>> {
    console.log('[PluginLoader] Loading plugins...')

    const pluginDirs = options?.pluginDirs ?? ['plugins', 'builtin-plugins']
    
    for (const dir of pluginDirs) {
      const resolvedPath = path.resolve(dir)
      if (fs.existsSync(resolvedPath)) {
        await this.loadPluginsFromDirectory(resolvedPath, options)
      }
    }

    console.log(`[PluginLoader] Loaded ${this.plugins.size} plugins`)
    return this.plugins
  }

  private async loadPluginsFromDirectory(
    dirPath: string,
    options?: PluginLoadOptions,
  ): Promise<void> {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const pluginPath = path.join(dirPath, entry.name)
      
      try {
        await this.loadPlugin(pluginPath, options)
      } catch (error) {
        console.error(`[PluginLoader] Failed to load plugin ${entry.name}:`, error)
        
        const pluginId = this.generatePluginId(entry.name)
        this.plugins.set(pluginId, {
          id: pluginId,
          manifest: {
            name: entry.name,
            version: '0.0.0',
            description: 'Failed to load',
            main: '',
          },
          rootPath: pluginPath,
          status: 'error',
          enabled: false,
          error: error as Error,
        })
      }
    }
  }

  private async loadPlugin(
    pluginPath: string,
    options?: PluginLoadOptions,
  ): Promise<void> {
    const manifestPath = path.join(pluginPath, 'plugin.json')
    
    if (!fs.existsSync(manifestPath)) {
      return
    }

    const manifestContent = fs.readFileSync(manifestPath, 'utf-8')
    const manifest: PluginManifest = JSON.parse(manifestContent)

    const pluginId = this.generatePluginId(manifest.name)

    const isExplicitlyDisabled = options?.disabledPlugins?.includes(pluginId)
    const isExplicitlyEnabled = options?.enabledPlugins?.includes(pluginId)
    const shouldEnable = !isExplicitlyDisabled && (isExplicitlyEnabled || manifest.enabled !== false)

    const definition: PluginDefinition = {
      id: pluginId,
      manifest,
      rootPath: pluginPath,
      status: 'unloaded',
      enabled: shouldEnable && !isExplicitlyDisabled,
    }

    if (shouldEnable && !isExplicitlyDisabled) {
      try {
        const mainPath = path.join(pluginPath, manifest.main)
        
        if (fs.existsSync(mainPath)) {
          const jiti = createJiti(pluginPath)
          const module = await jiti(mainPath)
          
          const pluginFactory = module.default ?? module
          
          if (typeof pluginFactory === 'function') {
            const instance = await pluginFactory(this.createPluginContext(pluginId))
            definition.instance = instance
            definition.status = 'loaded'

            this.registerPluginTools(instance.tools ?? [], pluginId)
            this.registerPluginCommands(instance.commands ?? [], pluginId)
          }
        }
      } catch (error) {
        definition.status = 'error'
        definition.error = error as Error
        console.error(`[PluginLoader] Error loading plugin ${manifest.name}:`, error)
      }
    }

    this.plugins.set(pluginId, definition)
  }

  getPlugin(pluginId: string): PluginDefinition | undefined {
    return this.plugins.get(pluginId)
  }

  getAllPlugins(): PluginDefinition[] {
    return Array.from(this.plugins.values())
  }

  getEnabledPlugins(): PluginDefinition[] {
    return this.getAllPlugins().filter(p => p.enabled && p.status === 'loaded')
  }

  getPluginTools(): Tools {
    return Array.from(this.toolRegistry.values()).map(r => r.tool)
  }

  getPluginCommands(): CommandDefinition[] {
    return Array.from(this.commandRegistry.values()).map(r => r.command)
  }

  async enablePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`)
    }

    if (plugin.enabled) {
      return
    }

    plugin.enabled = true
    
    if (plugin.status === 'unloaded') {
      // Reload the plugin
      await this.loadPlugin(plugin.rootPath)
    }

    console.log(`[PluginLoader] Enabled plugin: ${plugin.manifest.name}`)
  }

  async disablePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`)
    }

    plugin.enabled = false
    this.unregisterPluginTools(pluginId)
    this.unregisterPluginCommands(pluginId)

    console.log(`[PluginLoader] Disabled plugin: ${plugin.manifest.name}`)
  }

  async reloadPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`)
    }

    this.unregisterPluginTools(pluginId)
    this.unregisterPluginCommands(pluginId)

    await this.loadPlugin(plugin.rootPath)
    console.log(`[PluginLoader] Reloaded plugin: ${plugin.manifest.name}`)
  }

  private generatePluginId(name: string): string {
    const hash = createHash('sha256').update(name).digest('hex').substring(0, 8)
    return `${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${hash}`
  }

  private createPluginContext(pluginId: string): PluginContext {
    return {
      pluginId,
      state: {} as AppState,
      tools: [],
      getConfig: () => ({}),
      updateConfig: () => {},
    }
  }

  private registerPluginTools(tools: Tools, pluginId: string): void {
    for (const tool of tools) {
      this.toolRegistry.set(tool.name, { tool, pluginId })
    }
  }

  private registerPluginCommands(commands: CommandDefinition[], pluginId: string): void {
    for (const cmd of commands) {
      this.commandRegistry.set(cmd.name, { command: cmd, pluginId })
    }
  }

  private unregisterPluginTools(pluginId: string): void {
    for (const [key, value] of this.toolRegistry) {
      if (value.pluginId === pluginId) {
        this.toolRegistry.delete(key)
      }
    }
  }

  private unregisterPluginCommands(pluginId: string): void {
    for (const [key, value] of this.commandRegistry) {
      if (value.pluginId === pluginId) {
        this.commandRegistry.delete(key)
      }
    }
  }
}

export const PluginLoader = new PluginLoaderImpl()

export function definePlugin(factory: (context: PluginContext) => PluginInstance | Promise<PluginInstance>): () => PluginInstance | Promise<PluginInstance> {
  return factory
}
