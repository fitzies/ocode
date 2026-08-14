# ocode — Coding Agent Guide

## UI Component Standard — Strict

- Use **shadcn components only** for new or changed web UI. Do not introduce bespoke interactive primitives when a shadcn component exists.
- Use the **shadcn Mira style strictly** and preserve its tokens, sizing, interaction states, and composition patterns.
- The authoritative shadcn configuration is [`apps/web/components.json`](apps/web/components.json) (`style: "radix-mira"`).
- Installed Mira components live in [`apps/web/src/components/ui`](apps/web/src/components/ui); compose those components in product UI rather than recreating them.
- When a component is missing, add it through the shadcn CLI using the existing configuration, then adapt only what is necessary to match established Mira patterns.

## Product

ocode is a personal remote interface for persistent [Pi](https://github.com/badlogic/pi-mono) coding-agent sessions running on **Forge**, a dedicated headless server. A user can start work on one device, disconnect, and resume the same session elsewhere without interrupting the underlying Pi process.

The project was originally named Anvil. Use **ocode** (lowercase) for all new user-facing names. Existing `@anvil/*`, `ANVIL_*`, and other legacy identifiers remain only for compatibility; do not introduce new ones unless a wire or migration boundary requires them.

## Repository Map

- `apps/web` — React 19, Vite, TypeScript, Tailwind CSS client; also used as the Tauri frontend
- `apps/forge` — Node.js Forge API, durable state, Pi process supervisor, SSE/WebSocket transports, and static web serving
- `apps/desktop` — Tauri 2 desktop shell and Rust integration
- `packages/protocol` — client-independent wire types and domain contracts
- `packages/pi-rpc` — Pi RPC normalization shared by fixtures and Forge
- `packages/state` — deterministic event reducer and snapshot reconciliation
- `bin/ocode` — administrator CLI for building and managing the Forge service and Tailscale Serve
- `deploy` — configuration examples and systemd assets
- `docs/forge.md` — authoritative Forge configuration, security, deployment, persistence, and recovery notes

Package names intentionally remain under the internal `@anvil/*` scope.

## Architecture Rules

- Forge owns Pi processes, repositories, credentials, durable sessions, and authoritative state.
- Clients are replaceable views. Keep backend APIs client-independent and do not put correctness-critical state only in the browser or desktop shell.
- Pi runs must survive browser/app disconnects. A full Forge restart may interrupt live subprocesses, but durable session state must remain recoverable.
- Remote clients communicate through authenticated HTTP commands, globally sequenced SSE events, and bounded WebSocket channels—not SSH.
- Forge binds to loopback and is exposed only through Tailscale Serve. Never assume forwarded identity headers are safe on a publicly reachable listener.
- Trusted workspace roots are privileged. File, terminal, artifact, and Git operations must remain scoped to an authenticated, canonical project.
- Preserve unknown Pi RPC records and unknown tools through generic fallbacks. New Pi extensions must not require immediate client changes to remain usable.
- Prefer deterministic reducers, snapshots, stable command IDs, and replay-safe behavior. Never blindly repeat an operation whose outcome is unknown.
- Keep the implementation specific to Pi and reasonably small; do not grow it into a generic multi-provider agent platform.

## Development Setup

Requirements:

- Node.js 22.5 or newer (Node.js 24 LTS recommended)
- Corepack and pnpm 11.15.1
- Rust/Cargo and platform prerequisites for desktop work
- A C/C++ toolchain when `node-pty` has no matching prebuild

Install and run the fixture-backed web client:

```bash
corepack pnpm install
corepack pnpm dev
```

Run against a real Forge instance:

```bash
# terminal 1
OCODE_CONFIG=/path/to/config.json \
OCODE_ALLOW_UNAUTHENTICATED=true \
corepack pnpm dev:forge

# terminal 2
VITE_OCODE_TRANSPORT=forge corepack pnpm dev:web
```

Without `VITE_OCODE_TRANSPORT=forge`, web development uses deterministic recorded fixtures. Vite runs on port 5173 and proxies Forge HTTP and WebSocket traffic to loopback port 3210.

Do not start a development Forge against the production data directory while the service is running. Forge takes an exclusive instance lock; use a separate `OCODE_DATA_DIR` if both must exist.

Desktop commands:

```bash
corepack pnpm dev:desktop
corepack pnpm check:desktop
corepack pnpm test:desktop
corepack pnpm build:desktop
```

## Verification

Run the narrowest relevant checks while iterating, then expand according to the change:

```bash
# a single workspace
corepack pnpm --filter @anvil/web test
corepack pnpm --filter @anvil/forge typecheck

# repository-wide
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

For desktop Rust changes, also run:

```bash
corepack pnpm check:desktop
corepack pnpm test:desktop
```

Tests are generally colocated with source as `*.test.ts` or `*.test.tsx`. Add or update tests for protocol shapes, reducers, reconnection behavior, security boundaries, and user-visible state changes. Prefer focused regression tests over broad snapshots.

## Working Conventions

- Read the nearest implementation and tests before editing; do not infer behavior from filenames alone.
- Keep protocol changes end-to-end: wire types, RPC normalization, durable state/reducer behavior, Forge transport, fixtures, and client rendering may all need coordinated updates.
- Maintain backward compatibility for persisted data and legacy identifiers unless a migration is explicitly part of the task.
- Treat event ordering, reconnect cursors, process lifecycle, pending dialogs, and unknown command outcomes as correctness-sensitive.
- Bound queues, payloads, histories, and resource reads. Do not place large tool output or binary data directly into journal events when artifact externalization applies.
- Keep project file viewing read-only and fail closed on unsafe paths, symlinks, special files, unsupported hosts, or unauthenticated access.
- Avoid leaking secrets from Pi configuration, environment variables, terminal history, tool output, or Forge state into logs, fixtures, tests, or client errors.
- Use canonical `OCODE_*` and `VITE_OCODE_*` names for new configuration. Legacy environment variables are migration fallbacks only.
- Do not weaken loopback binding, owner authentication, same-origin checks, Tailscale-only access, or workspace validation for convenience.
- Keep UI behavior functional in both browser and Tauri contexts. Use existing components and interaction patterns before adding another abstraction.
- Preserve a robust generic renderer for unknown tools even when adding a specialized card.

## Worktree Safety

This repository may contain concurrent or unfinished work.

- Inspect Git status before making broad changes.
- Do not revert, reformat, delete, or overwrite unrelated modifications or untracked files.
- Keep edits scoped to the requested task and call out pre-existing failures separately.
- Do not commit, push, force-push, pull/rebase, or mutate deployment state unless the user explicitly asks.
- Never run production service, Tailscale, database migration, or publishing commands as part of ordinary verification.

## ocode Administrator CLI

`bin/ocode` is the canonical operator interface for the installed Forge service:

```bash
ocode start      # start the service and enable Tailscale Serve
ocode stop       # stop the service and disable Tailscale Serve
ocode restart    # rebuild, restart, and re-enable Serve
ocode rebuild    # build without restarting
ocode status     # show service health, Serve state, and Pi processes
ocode logs       # follow the service journal
```

The CLI prefers `ocode-forge.service` while safely detecting an active legacy `anvil-forge.service`. It refuses to start one while the other is active. New operator functionality belongs in `bin/ocode`; keep `bin/anvil` only as a compatibility shim. `OCODE_URL` is canonical, with `ANVIL_URL` accepted only as a legacy fallback.

These commands mutate the production service or Tailscale state (except `status` and `logs`). Do not invoke them during ordinary development or verification without explicit user approval.

## Deployment and Security

The current production shape is the built web client served by Forge on `127.0.0.1:3210`, exposed with Tailscale Serve. Do not enable Funnel or public port forwarding.

Use `docs/forge.md` as the source of truth before changing configuration, authentication, project file access, terminals, Git actions, persistence, service management, artifacts, the administrator CLI, or recovery semantics. Keep `bin/ocode`, `deploy/config.example.json`, environment documentation, and systemd assets synchronized with behavior changes.

## Current Direction

The protocol-complete client and persistent Forge runtime are implemented. Current work should prioritize compatibility and production hardening: personalized Pi setups, structured extension interactions, specialized tool cards with generic fallbacks, crash/restart recovery, backpressure and large outputs, desktop support, accessibility, and cross-device reliability.

Out of scope unless explicitly requested: multiple users, public internet access, cloud relay/synchronization, collaboration, a full IDE, or turning ocode into a general multi-provider platform.
