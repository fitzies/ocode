# ocode

A personal remote interface for persistent [Pi](https://github.com/badlogic/pi-mono) coding-agent sessions running on Forge.

Start a task on one device, disconnect, and continue the same session elsewhere without interrupting the underlying Pi process. Forge keeps execution and durable state on a dedicated headless server, while the web and desktop clients act as replaceable views.

> The product was originally named Anvil. Internal `@anvil/*` packages and selected wire identifiers remain unchanged for backward compatibility. New user-facing names use lowercase **ocode**.

## Workspace

- `apps/web` — React, Vite, and TypeScript client; also used as the desktop frontend
- `apps/forge` — persistent Node.js API, durable state, and Pi process supervisor
- `apps/desktop` — Tauri 2 desktop shell
- `packages/protocol` — client-independent wire and domain types
- `packages/pi-rpc` — Pi RPC normalization shared by fixtures and Forge
- `packages/state` — deterministic event reducer and snapshot reconciliation
- `bin/ocode` — administrator CLI for the Forge service
- `deploy` — configuration examples and systemd assets

## Requirements

- Node.js 22.5 or newer; Node.js 24 LTS is recommended
- Corepack and pnpm 11.15.1
- A C/C++ build toolchain when `node-pty` has no matching prebuild
- Rust/Cargo and platform prerequisites for desktop development

## Development

Install dependencies and run the fixture-backed web client:

```bash
corepack pnpm install
corepack pnpm dev
```

Recorded Pi fixtures are used by default, so Forge is not required for ordinary client development.

To run against a real Forge instance:

```bash
# terminal 1
OCODE_CONFIG=/path/to/config.json \
OCODE_ALLOW_UNAUTHENTICATED=true \
corepack pnpm dev:forge

# terminal 2
VITE_OCODE_TRANSPORT=forge corepack pnpm dev:web
```

Vite runs on port 5173 and proxies API and WebSocket traffic to Forge on `127.0.0.1:3210`.

### Desktop

```bash
corepack pnpm dev:desktop
corepack pnpm check:desktop
corepack pnpm test:desktop
corepack pnpm build:desktop
```

## Verification

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Run the narrowest relevant workspace checks while iterating, for example:

```bash
corepack pnpm --filter @anvil/web test
corepack pnpm --filter @anvil/forge typecheck
```

## Forge Deployment

The production deployment serves the built web client and API from Forge on loopback, then exposes it privately through Tailscale Serve. Do not expose port 3210 publicly or enable Tailscale Funnel.

Create `~/.config/ocode/config.json` from `deploy/config.example.json`, then build and start Forge:

```bash
corepack pnpm build
corepack pnpm start:forge
```

In an administration shell, expose the loopback listener:

```bash
sudo tailscale serve --bg http://127.0.0.1:3210
```

For systemd installation, authentication, trusted workspaces, persistence, backups, migration, resource access, and recovery semantics, see [`docs/forge.md`](docs/forge.md).

## Administrator CLI

Install the management command on the Forge host:

```bash
sudo ln -sf /opt/ocode/bin/ocode /usr/local/bin/ocode
```

Then manage the installed service with:

```bash
ocode start      # start Forge and enable Tailscale Serve
ocode stop       # stop Forge and disable Tailscale Serve
ocode restart    # rebuild and restart
ocode rebuild    # build without restarting
ocode status     # show service, health, Serve, and Pi process status
ocode logs       # follow service logs
```

The CLI prefers `ocode-forge.service` and safely handles migration from the legacy `anvil-forge.service` name.

## Security Model

ocode is designed for personal, single-user, Tailscale-only access:

- Forge binds to loopback and trusts Tailscale identity headers only behind Tailscale Serve.
- Every workspace must be explicitly trusted and canonicalized.
- Terminals and Pi processes run with the Forge operating-system account's permissions.
- Project file access is authenticated, read-only, and constrained to trusted roots.
- Large tool output and binary resources are stored as authenticated artifacts rather than embedded in the event journal.

Treat Forge configuration, state, terminal history, repositories, and Pi credentials as sensitive.
