# openLittleTwo

🤖 **AI-Powered Multi-Channel Gateway with Efficient Algorithm Architecture**

A modern, extensible AI gateway platform that combines the **efficient algorithm architecture from Claude Code** with the **comprehensive functionality of OpenClaw**.

## 🎯 Project Overview

openLittleTwo is designed to be a high-performance, feature-rich AI assistant framework that:

### From Claude Code (Algorithm & Architecture):
✅ **Efficient Task Management System** - State machine-based task lifecycle with priority queues  
✅ **Advanced Tool Interface Pattern** - Factory pattern with permission system and lazy loading  
✅ **Intelligent Query Engine** - Context compaction, token budget optimization, streaming responses  
✅ **Reactive State Management** - Memoization, LRU cache, real-time updates  
✅ **Modular Command System** - Dynamic loading, feature flags, dead code elimination  

### From OpenClaw (Functionality):
✅ **Multi-Channel Integration** - IRC, Slack, Telegram, Discord, Matrix, Line, WhatsApp, WebChat  
✅ **Plugin System** - Dynamic plugin loading, lifecycle management, hot-reload support  
✅ **Gateway Server** - WebSocket communication, authentication, event-driven architecture  
✅ **CLI Toolchain** - Comprehensive command-line interface with rich subcommands  
✅ **Agent System** - Sandbox execution, multi-agent coordination  
✅ **Security Features** - Permission model, audit logging, secret management  

## 📁 Project Structure

```
openLittleTwo/
├── src/
│   ├── core/                    # Core Algorithm Architecture (from Claude Code)
│   │   ├── Task.ts             # Task state machine and lifecycle
│   │   ├── Tool.ts             # Tool interface and factory pattern
│   │   ├── QueryEngine.ts      # Intelligent query processing engine
│   │   └── StateManager.ts     # Reactive state management
│   │
│   ├── channels/               # Multi-Channel Support (from OpenClaw)
│   │   └── BaseChannel.ts      # Abstract channel base class
│   │
│   ├── plugins/                # Plugin System (from OpenClaw)
│   │   └── PluginSystem.ts     # Plugin loader and registry
│   │
│   ├── gateway/                # Gateway Server (from OpenClaw)
│   │   └── GatewayServer.ts    # WebSocket server implementation
│   │
│   ├── cli/                    # CLI Interface
│   │   ├── index.ts            # Entry point
│   │   └── CommandRouter.ts    # Command routing system
│   │
│   ├── tools/                  # Built-in Tools
│   │   └── builtinTools.ts     # Core tool implementations
│   │
│   └── index.ts                # Main exports
│
├── package.json
├── tsconfig.json
└── README.md
```

## 🚀 Quick Start

### Installation

```bash
# Clone or navigate to the project directory
cd openLittleTwo

# Install dependencies
npm install

# Build the project
npm run build
```

### Usage

#### Start Gateway Server
```bash
# Start on default port 8080
npm run cli -- start

# Custom port and host
npm run cli -- start --port 3000 --host localhost
```

#### Interactive Chat Mode
```bash
npm run cli -- chat
```

#### Manage Channels
```bash
# List all channels
npm run cli -- channel list

# Check channel status
npm run cli -- channel status
```

#### Manage Plugins
```bash
# List installed plugins
npm run cli -- plugin list

# Enable a plugin
npm run cli -- plugin enable my-plugin

# Disable a plugin
npm run cli -- plugin disable my-plugin
```

#### System Status
```bash
npm run cli -- status
```

#### Configuration
```bash
# View all config
npm run cli -- config list

# Get specific config value
npm run cli -- config get debug

# Set config value
npm run cli -- config set debug true
```

#### Task Management
```bash
# List active tasks
npm run cli -- task

# View task details
npm run cli -- task <task-id>

# Show all tasks including completed
npm run cli -- task --all
```

## 🏗️ Architecture Highlights

### 1. Task Management System (from Claude Code)

Implements a sophisticated task state machine:

```typescript
type TaskType = 
  | 'local_bash'       // Shell commands
  | 'local_agent'      // AI agent tasks
  | 'remote_agent'     // Remote agent tasks
  | 'channel_message'  // Channel message handling
  | 'plugin_task'      // Plugin-specific tasks
  | 'gateway_request'  // WebSocket requests

type TaskStatus = 
  | 'pending' → 'running' → 'completed' | 'failed' | 'killed'
  | ↔ 'paused'
  | ↔ 'retrying'
```

**Key Features:**
- Priority queue system (low/normal/high/critical)
- Automatic retry mechanism with configurable limits
- Concurrent task limiting
- Graceful cancellation via AbortController
- Task output persistence to disk

### 2. Tool Interface Pattern (from Claude Code)

Clean factory-based tool creation:

```typescript
const MyTool = buildTool({
  name: 'my_tool',
  description: async () => 'Tool description',
  inputSchema: z.object({ /* Zod schema */ }),
  
  async call(args, context, canUseTool) {
    // Implementation
    return { data: result }
  },
  
  // Optional safety features
  isReadOnly: () => false,
  isDestructive: () => true,
  isConcurrencySafe: () => false,
})
```

**Built-in Tools:**
- `bash` - Execute shell commands
- `read` / `write` - File operations
- `grep` - Pattern search
- `glob` - File discovery

### 3. Query Engine (from Claude Code)

Intelligent context management:

- **Token Budget Optimization**: Tracks usage per turn
- **Context Compaction**: Automatically compresses long conversations
- **Tool Orchestration**: Parallel tool execution with dependency resolution
- **Streaming Responses**: Real-time output delivery
- **Error Recovery**: Graceful degradation on failures

### 4. Channel Integration (from OpenClaw)

Multi-platform messaging support:

| Channel Type | Status | Protocol |
|-------------|--------|----------|
| IRC | ✅ Planned | IRC protocol |
| Slack | ✅ Planned | Slack API |
| Telegram | ✅ Planned | Bot API |
| Discord | ✅ Planned | Discord.js |
| Matrix | ✅ Planned | Matrix SDK |
| Line | ✅ Planned | Line Messaging API |
| WhatsApp | ✅ Planned | Business API |
| WebChat | ✅ Planned | WebSocket |
| Webhook | ✅ Planned | HTTP endpoints |

### 5. Plugin System (from OpenClaw)

Extensible plugin architecture:

```typescript
// plugin.json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "main": "index.ts"
}

// index.ts
import { definePlugin } from 'openlittletwo'

export default definePlugin((context) => ({
  tools: [/* custom tools */],
  channels: [/* channel integrations */],
  hooks: {
    onMessage: async (message) => { /* ... */ },
  }
}))
```

**Plugin Capabilities:**
- Provide custom tools
- Add new channel integrations
- Register CLI commands
- Hook into message lifecycle
- Manage own configuration

### 6. Gateway Server (from OpenClaw)

Real-time communication hub:

```typescript
const gateway = new GatewayServer({
  port: 8080,
  host: '0.0.0.0',
  authSecret: process.env.AUTH_SECRET,
})

await gateway.start()

// Handle events
gateway.on('client_connected', (event) => {
  console.log('New client:', event.clientId)
})

// Send messages
gateway.sendToClient(clientId, {
  type: 'response',
  payload: { text: 'Hello!' }
})

// Broadcast to all authenticated clients
gateway.broadcast({
  type: 'event',
  payload: { type: 'notification', data: {} }
})
```

**Features:**
- WebSocket connection management
- Client authentication
- Heartbeat monitoring
- Message broadcasting
- Event-driven architecture
- Connection limits

## 🔧 Development

### Adding New Tools

Create a file in `src/tools/`:

```typescript
// src/tools/my-tool.ts
import { z } from 'zod'
import { buildTool } from '../core/Tool'

export const MyTool = buildTool({
  name: 'my_tool',
  inputSchema: z.object({ query: z.string() }),
  
  async call(args) {
    return { data: `Result for: ${args.query}` }
  },
  
  isReadOnly: () => true,
})
```

Register in `src/tools/builtinTools.ts`:

```typescript
export const getBuiltinTools = (): Tools => [
  // ... existing tools
  MyTool,
]
```

### Adding New Channels

Extend `BaseChannel`:

```typescript
// src/channels/my-channel.ts
import { BaseChannel, ChannelConfig } from './BaseChannel'

export class MyChannel extends BaseChannel {
  readonly type = 'custom' as const
  readonly name = 'My Channel'

  async connect() {
    // Initialize connection
    this.setStatus('connected')
  }

  async disconnect() {
    // Cleanup
    this.setStatus('disconnected')
  }

  async sendMessage(userId, content) {
    // Send message
  }

  async handleMessage(message) {
    // Process incoming message
  }
}
```

### Creating Plugins

See `plugins/` directory structure:

```
my-plugin/
├── plugin.json          # Manifest
├── index.ts            # Entry point
├── tools/              # Custom tools
└── README.md           # Documentation
```

## 📊 Performance Optimizations

Inherited from Claude Code's efficient design:

1. **Memoization**: Expensive computations cached automatically
2. **Lazy Loading**: Modules loaded on-demand to reduce startup time
3. **Dead Code Elimination**: Feature flags remove unused code paths
4. **LRU Caching**: Intelligent cache eviction prevents memory bloat
5. **Parallel Execution**: Independent tasks run concurrently
6. **Streaming I/O**: Large results streamed to reduce memory pressure
7. **Context Compression**: Long conversations summarized efficiently

## 🔒 Security Model

Permission system inspired by Claude Code:

- **Tool-level permissions**: Each tool declares safety properties
- **Input validation**: Zod schemas enforce strict types
- **Sandboxing**: Agent execution isolated from host
- **Audit logging**: All actions recorded for compliance
- **Rate limiting**: Prevent abuse and resource exhaustion
- **Authentication**: Secure client verification

## 🌐 Integrations

### Supported Platforms (from OpenClaw)

- **Messaging**: Slack, Telegram, Discord, IRC, Matrix, Line, WhatsApp
- **Voice**: TTS/STT integration planned
- **Media**: Image/audio/video processing pipeline
- **Web**: Browser automation, web scraping
- **Code**: Git integration, IDE extensions
- **Cloud**: AWS, GCP, Azure adapters

### AI Providers

Pluggable AI backend:

- OpenAI API
- Anthropic Claude
- Local models (Ollama, llama.cpp)
- Custom providers via plugin interface

## 📝 API Reference

Detailed API documentation available in source code TypeScript definitions.

Key exports:
- `Task` - Task management types and utilities
- `Tool` / `buildTool` - Tool interface and factory
- `QueryEngine` - Query processing engine
- `StateManager` - Global state management
- `BaseChannel` / `ChannelRegistry` - Channel abstraction
- `GatewayServer` - WebSocket gateway
- `PluginLoader` - Plugin system
- `CLICommandRouter` - CLI framework

## 🤝 Contributing

Contributions welcome! Please read our guidelines:

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing`)
4. Open Pull Request

## 📄 License

MIT License - see LICENSE file for details.

## 🙏 Acknowledgments

- **Claude Code** - For the elegant algorithm architecture and design patterns
- **OpenClaw** - For the comprehensive multi-channel gateway functionality
- The open-source community for inspiration and tools

---

Built with ❤️ using algorithms from Claude Code + functionality from OpenClaw
