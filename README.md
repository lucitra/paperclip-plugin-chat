# @paperclipai/plugin-chat

Multi-adapter AI chat plugin for Paperclip. Provides a conversational interface to Paperclip agents with thread management, slash commands, and real-time streaming.

## Lucitra Fork

This is [Lucitra's](https://lucitra.ai) fork of [webprismdevin/paperclip-plugin-chat](https://github.com/webprismdevin/paperclip-plugin-chat). We use it as the chat interface for our [Paperclip fork](https://github.com/lucitra/paperclip).

**What this fork adds:**
- Auto-installed as a bundled plugin on Paperclip startup
- Integrated with our Linear plugin for issue-aware conversations

**Related:**
- [lucitra/paperclip](https://github.com/lucitra/paperclip) — Paperclip fork with Linear integration
- [lucitra/paperclip-plugin-linear](https://github.com/lucitra/paperclip-plugin-linear) — Linear issue sync plugin

---

## How It Works

The plugin creates a chat UI inside the Paperclip plugin page slot. When a user sends a message, the plugin:

1. Creates a thread (persisted in plugin state)
2. Finds a compatible agent via `ctx.agents.list()` (prefers "Chat Assistant", falls back to role "general")
3. Creates or resumes an agent session via `ctx.agents.sessions`
4. Streams the agent's response back to the UI

All LLM access goes through Paperclip's agent session system. The plugin does not talk to models directly — it talks to agents that talk to models. See [Plugin vs Core Analysis](docs/plugin-vs-core-chat.md) for the implications of this architecture.

## Prerequisites

- A running Paperclip instance
- At least one agent with `adapterType: "claude_local"` (or another supported adapter)
- The plugin installed and enabled in **Settings > Plugins**

## Build

```bash
npm run build
```

Produces `dist/worker.js` (server-side) and `dist/ui/index.js` (browser bundle).

### Docker deployment

```bash
docker cp dist/ui/index.js paperclip-plugin-chat-server-1:/app/packages/plugins/plugin-chat/dist/ui/index.js
```

Hard refresh the browser after deploying — the server caches bundles with ETags.

## Features

### Chat UI
- Welcome screen with quick action chips (check issues, review goals, plan work, agent status)
- Threaded conversations with sidebar navigation
- Rich markdown rendering (tables, code blocks, lists, links, blockquotes)
- Collapsible tool usage display ("Used 3 tools Bash x3")
- Auto-generated thread titles from first message
- Inline thread rename (double-click) and delete (with confirmation)

### Slash Commands
Type `/` in the input to access built-in commands:

| Command | Action |
|---------|--------|
| `/tasks` | List active tasks |
| `/dashboard` | Workspace dashboard |
| `/agents` | Agent status overview |
| `/create` | Create a new task |
| `/projects` | List projects |
| `/costs` | Cost breakdown |
| `/activity` | Recent activity |
| `/blocked` | Blocked tasks |
| `/plan` | Plan and break down work |
| `/handoff` | Hand off work to an agent |

### Streaming
The plugin supports real-time streaming via SSE (`ctx.streams`). During agent execution, users see live text output with a blinking cursor, tool activity indicators, and a stop button.

## Configuration

Navigate to **Settings > Plugins > Chat** (gear icon):

| Setting | Description |
|---------|-------------|
| Default Adapter | Adapter type for new threads (`claude_local`, `codex_local`, `opencode_local`) |
| System Prompt Override | Custom text appended to chat sessions |

## Plugin Capabilities

| Capability | Purpose |
|-----------|---------|
| `ui.page.register` | Full chat page at `/:prefix/plugins/:pluginId` |
| `ui.sidebar.register` | Sidebar entry point |
| `agent.sessions.*` | Create and message agent sessions |
| `agents.read` | Discover available agents/adapters |
| `plugin.state.*` | Thread and message persistence |
| `activity.log.write` | Activity logging |

## Architecture

```
Browser                          Server
-------                          ------
ChatPage (React)
  |
  |-- usePluginData("threads")    --> Worker: getData("threads")
  |-- usePluginData("messages")   --> Worker: getData("messages")
  |-- usePluginAction("sendMessage") --> Worker: sendMessage action
  |                                      |
  |                                      |--> ctx.agents.sessions.create()
  |                                      |--> ctx.agents.sessions.sendMessage()
  |                                      |      |
  |                                      |      +--> Agent adapter --> CLI process
  |                                      |      |
  |                                      |      +--> onEvent callbacks
  |                                      |
  |                                      |--> ctx.streams.emit() (SSE)
  |
  |-- usePluginStream("chat:threadId") <-- SSE events (text, thinking, tool, done)
```

## Known Limitations

- **No direct LLM access** — requires a pre-configured agent; can't create agents or select models
- **Agent sessions are task-oriented** — no way to distinguish "answer this question" from "execute this task"
- **No design system** — UI is built with inline styles and CSS variable fallbacks
- **No deep linking** — thread state is lost on page refresh
- **No toast/dialog** — errors go to console only
- **Host page chrome** — breadcrumbs and back button can't be hidden

For the full analysis, see [Plugin vs Core: Chat Feature Analysis](docs/plugin-vs-core-chat.md).

## Testing

See the [Testing Guide](docs/plugin-chat-testing-guide.md) for setup instructions, a full test checklist, and troubleshooting steps.

## Related Docs

| Document | Description |
|----------|-------------|
| [Plugin vs Core Analysis](docs/plugin-vs-core-chat.md) | Why chat as a plugin has fundamental limitations |
| [Testing Guide](docs/plugin-chat-testing-guide.md) | Test checklist and setup for testers |
| [Core Integration Spec](docs/chat-core-integration.md) | Recommendation for building chat as a core page |
| [Streaming Implementation](docs/plugin-chat-streaming-implementation.md) | SSE streaming architecture notes |
| [Stream Bus Gap](docs/stream-bus-wiring-gap.md) | Stream bus wiring analysis |
