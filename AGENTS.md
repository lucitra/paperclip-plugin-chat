# paperclip-plugin-chat

Codex guidance for the Paperclip chat plugin.

## Purpose

Multi-adapter chat UI for Paperclip agents with threads, slash commands, rich markdown rendering, and streaming through Paperclip agent sessions.

## Development

```sh
npm run build
```

Run additional scripts only if they exist in `package.json`.

## Rules

- The plugin does not call models directly; route through Paperclip's agent session system.
- Keep worker, UI bundle, manifest, and plugin state contracts synchronized.
- Preserve compatibility with bundled installation in the Lucitra Paperclip fork.
- After deploying a UI bundle into a running Paperclip instance, remember browser caching may require a hard refresh.
