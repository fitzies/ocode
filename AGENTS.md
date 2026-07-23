# Anvil

Anvil is a personal, remote interface for running Pi coding-agent sessions on **Forge**, a dedicated headless coding server. It should let the user start a task on one device, disconnect, and continue the same session from another device without interrupting work.

## Architecture

- Forge owns the backend, Pi processes, repositories, credentials, and persistent sessions.
- Pi is integrated through its RPC mode or TypeScript SDK; prefer RPC subprocesses initially for session isolation.
- Remote clients communicate with the backend through HTTP commands and globally sequenced SSE events over Tailscale—not through SSH.
- SSH is reserved for server administration, deployment, and troubleshooting.
- The backend API must remain client-independent. The first client may be web-based or native, and additional clients should be able to share the same sessions later.
- A future native client may also run Pi locally to work directly with files on that device.
- Run the backend as a persistent system service so browser or app disconnections do not stop active work.

## Initial Scope

- Personal, single-user, Tailscale-only access
- Project and conversation selection
- Persistent and resumable Pi sessions
- Streaming messages, thinking, tool calls, and tool output
- Prompting, steering, follow-ups, and cancellation
- Model and thinking-level selection
- Pi extension dialogs and approvals
- Reliable reconnection and state restoration
- A minimal usable client without committing the project to a permanent UI platform

## Client Direction

The final client strategy is intentionally undecided. Options include a responsive web interface, a native SwiftUI application, or both. Build the Forge backend and its client-independent protocol first. Use a thin client to validate the complete workflow before investing in platform-specific polish.

## Principles

- Build specifically for Pi rather than recreating a multi-provider platform.
- Keep execution and durable state on Forge; clients are replaceable views.
- Prefer a small, understandable system over T3 Code's broader architecture.
- Treat shell and filesystem access as highly privileged.
- Do not expose Anvil publicly by default.
- Prioritize reliability across disconnects before advanced UI features.

## Current Runbook

Phase 2 is implemented. The current usable deployment is the built web client served by the Forge backend on loopback and exposed with Tailscale Serve.

1. Create `~/.config/anvil/config.json` from `deploy/config.example.json`. Set the exact Tailscale owner login, Pi executable, and initial allowlisted project paths. Additional trusted workspaces can be added later by the authenticated owner from the web client.
2. Build and start from the repository root:

   ```bash
   corepack pnpm build
   corepack pnpm start:forge
   ```

3. In another Forge administration shell, expose the loopback service:

   ```bash
   sudo tailscale serve --bg http://127.0.0.1:3210
   ```

4. Open the Forge tailnet HTTPS URL. Do not expose port 3210 publicly or enable Funnel.

For frontend development, run Forge with `ANVIL_ALLOW_UNAUTHENTICATED=true`, then run `VITE_ANVIL_TRANSPORT=forge corepack pnpm dev:web`; Vite uses port 5173 and proxies `/api` to Forge. Without `VITE_ANVIL_TRANSPORT=forge`, development uses recorded fixtures.

To stop a manual deployment, interrupt `start:forge` with Ctrl+C and run `sudo tailscale serve --https=443 off`. If a detached development process remains, identify and terminate the process listening on port 3210 (Forge) or 5173 (Vite). Production service installation and recovery details are in `docs/forge.md` and `deploy/anvil-forge.service`.

## Delivery Phases

### Phase 1 — Define the Real Client Contract

Turn the current mock UI into a protocol-complete frontend foundation.

- Expand `@anvil/protocol` for raw messages, streaming, reasoning, parallel tools, arbitrary details, images, errors, and extension interactions.
- Add generic tool rendering with optional specialized cards.
- Add native select, multi-select, confirm, input, and editor dialogs.
- Make models, thinking levels, commands, and skills dynamic.
- Drive the client with recorded Pi RPC fixtures before connecting it to Forge.

This phase is complete when the client can replay realistic Pi sessions, including unknown extensions, without Forge running.

### Phase 2 — Build the Forge Runtime

Implement the persistent backend and connect the client to real Pi RPC processes.

- Start, monitor, resume, and cancel isolated Pi subprocesses.
- Load each user's normal Pi configuration, extensions, packages, and skills.
- Normalize Pi RPC into the Anvil protocol.
- Journal events with sequence numbers and retain pending dialogs.
- Support prompts, steering, follow-ups, models, thinking levels, commands, session switching, and reconnection.
- Expose the backend through a secure Tailscale-only API and streaming transport.

This phase is complete when a task continues on Forge with every client disconnected and restores correctly on another device.

### Phase 3 — Compatibility and Production Hardening

Make the complete workflow dependable across personalized Pi installations.

- Add an Anvil compatibility extension or upstream Pi RPC support for multi-select and other structured interactions.
- Add native cards for Firecrawl, Agent Browser, images, subagents, diffs, and approvals.
- Preserve a robust generic fallback for every unknown tool or extension.
- Handle process crashes, backend restarts, stale clients, backpressure, large outputs, and artifacts.
- Add service installation, access controls, audit logging, and cross-device end-to-end tests.
- Polish responsive behavior and accessibility after the full workflow is reliable.

This phase is complete when Anvil runs as a persistent Forge service and supports ordinary personalized Pi setups without requiring client changes for every new tool.

## Out of Scope for the First Version

- Multiple users or public accounts
- Public internet access
- Desktop SSH orchestration
- Cloud relay or synchronization
- Full code editor or IDE replacement
- GitHub integration and automated worktree management
- Collaboration features

