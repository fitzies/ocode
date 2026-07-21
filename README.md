# Anvil

A personal remote interface for persistent [Pi](https://github.com/badlogic/pi-mono) coding-agent sessions running on Forge.

## Workspace

- `apps/web` — Vite, React, and TypeScript client
- `packages/protocol` — client-independent shared domain types

The first milestone is a UI prototype backed by an in-memory mock client. No Forge backend is implemented yet.

## Development

```bash
corepack pnpm install
corepack pnpm dev
```

Then open the local URL printed by Vite.
