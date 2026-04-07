// Simple entry point that doesn't require TypeScript compilation
// This file can be run directly with Node.js

console.log(`
╔══════════════════════════════════════════╗
║     🤖 openLittleTwo v1.0.0              ║
║  AI-Powered Multi-Channel Gateway         ║
╚══════════════════════════════════════════╝

Welcome to openLittleTwo!

This project combines:
✅ Claude Code's efficient algorithm architecture
✅ OpenClaw's comprehensive functionality

To get started:
1. Run 'npm install' to install dependencies
2. Run 'npm run cli -- start' to start the gateway server
3. Run 'npm run cli -- chat' for interactive chat mode

Available commands:
  start       Start the gateway server
  status      Show system status
  channel     Manage communication channels
  plugin      Manage plugins
  chat        Start interactive chat mode
  config      Manage configuration
  task        View and manage tasks

For more information, see README.md
`);

// Export version info
export default {
  name: 'openLittleTwo',
  version: '1.0.0',
  description: 'AI-powered multi-channel gateway'
};
