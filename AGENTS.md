# Anvil

Anvil is a personal, remote interface for running Pi coding-agent sessions on **Forge**, a dedicated headless coding server. It should let the user start a task on one device, disconnect, and continue the same session from another device without interrupting work.

## Architecture

- Forge owns the backend, Pi processes, repositories, credentials, and persistent sessions.
- Pi is integrated through its RPC mode or TypeScript SDK; prefer RPC subprocesses initially for session isolation.
- Remote clients communicate with the backend through a secure API over Tailscale—not through SSH. The streaming transport may be WebSockets, SSE, or another suitable protocol and is not decided yet.
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

## Out of Scope for the First Version

- Multiple users or public accounts
- Public internet access
- Desktop SSH orchestration
- Cloud relay or synchronization
- Full code editor or IDE replacement
- GitHub integration and automated worktree management
- Collaboration features

