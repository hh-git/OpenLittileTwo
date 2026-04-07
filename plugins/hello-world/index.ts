import { z } from 'zod'
import { definePlugin, type PluginContext, type PluginInstance } from '../../src/plugins/PluginSystem.js'
import { buildTool } from '../../src/core/Tool.js'

const HelloToolInputSchema = z.object({
  name: z.string().optional().describe('Name to greet'),
  enthusiastic: z.boolean().optional().describe('Add enthusiasm to the greeting'),
})

const HelloTool = buildTool({
  name: 'hello',
  description: async () => 
    'Say hello! A simple greeting tool from the Hello World plugin.',
  inputSchema: HelloToolInputSchema,
  
  async call(
    args: z.infer<typeof HelloToolInputSchema>,
    _context: any,
    _canUseTool: any,
    _parentMessage: any,
  ) {
    const name = args.name ?? 'World'
    const suffix = args.enthusiastic ? ' 🎉' : ''
    
    return {
      data: `Hello, ${name}!${suffix}\n\nThis message is brought to you by the Hello World plugin.`,
    }
  },
  
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  userFacingName: (input) => `Hello${input?.name ? ` ${input.name}` : ''}`,
})

export default definePlugin((context: PluginContext): PluginInstance => ({
  tools: [HelloTool],
  
  commands: [
    {
      name: 'hello',
      description: 'Say hello from the plugin',
      handler: async (args) => {
        const name = (args.name as string) ?? 'World'
        console.log(`👋 Hello, ${name}! (from hello-world plugin)`)
        return `Hello, ${name}!`
      },
      parameters: {
        name: { type: 'string', required: false, description: 'Your name' },
      },
    },
  ],
  
  hooks: {
    onMessage: async (message: any, context: PluginContext) => {
      // Log all messages for demonstration
      if (process.env.DEBUG === 'true') {
        console.log(`[HelloWorld Plugin] Received message:`, message)
      }
    },
    
    beforeResponse: async (response: string, context: PluginContext) => {
      // Append a signature to responses
      return `${response}\n\n_Sent via openLittleTwo with hello-world plugin_`
    },
  },
  
  config: {
    greetingStyle: 'friendly',
    showTimestamp: true,
  },
}))
