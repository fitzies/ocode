# Anvil

A personal remote interface for persistent [Pi](https://github.com/badlogic/pi-mono) coding-agent sessions running on Forge.

## Workspace

- `apps/web` — Vite, React, and TypeScript client
- `apps/forge` — persistent Node.js Forge API and Pi process supervisor
- `packages/protocol` — client-independent wire and domain types
- `packages/pi-rpc` — Pi RPC normalization shared by fixtures and Forge
- `packages/state` — deterministic event reducer and snapshot reconciliation

## Development

```bash
corepack pnpm install
corepack pnpm dev
```

Development uses recorded Pi fixtures by default. To run against Forge, configure a project and start both processes:

```bash
ANVIL_CONFIG=/path/to/config.json corepack pnpm dev:forge
VITE_ANVIL_TRANSPORT=forge corepack pnpm dev:web
```

See [`docs/forge.md`](docs/forge.md) for configuration, systemd, Tailscale, persistence, and recovery details.

## Verification

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```
