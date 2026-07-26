# Project Workspace Surfaces Implementation

## Status

Implementation specification for adding project-scoped terminals, project file viewing, an agent-driven `openFile` capability, and a future file tree to Anvil.

This document is intended to be handed to multiple coding agents. Every agent must also read `AGENTS.md` and inspect the current implementation before changing files.

## Goal

Add two new project-level workspace surfaces without coupling them to Pi conversation threads:

1. A terminal workspace with multiple running terminals, tabs, and optional splits.
2. A resource viewer that can display source files, Markdown, safe HTML, and later a project file tree.

Both features must use one shared responsive workspace layout. They must not independently restructure `AppShell` or invent separate project-selection models.

## Product Decisions

These decisions are fixed for the first implementation unless the user explicitly changes them.

- Terminals belong to projects, not sessions/threads.
- A project may have multiple terminal processes identified by `terminalId`.
- Every new terminal starts at the canonical project root.
- Terminal processes survive browser disconnection, page reload, thread switching, and moving to another client while Forge remains running.
- Terminal processes do not need to survive a Forge service restart in the first version.
- Bounded terminal history is persisted on Forge and survives browser disconnection and Forge restarts.
- Exact terminal panel height and split sizing do not need to be restored.
- Terminal process identity and history are server-owned. Persist minimal terminal records and bounded history so known terminals can be shown as exited/restartable after Forge restarts. Presentation and grouping remain client-local and keyed by project.
- Desktop uses a bottom terminal surface and a right resource surface.
- Mobile uses full-screen surfaces and displays one terminal at a time. Do not use a partial bottom drawer for the mobile terminal.
- `openFile` is a generic project-resource action, not a one-off viewer implementation.
- File viewing is read-only initially. A full editor is out of scope.
- File APIs are project-scoped, even when the action originated in a Pi thread.
- Ghostty is not used in the web client. Use xterm.js. Ghostty may be reconsidered for a future native client.
- Do not put terminal output into the globally sequenced Anvil SSE event journal.
- Do not build a generic plugin/panel framework. Typed `main`, `bottom`, and `right` surfaces are enough.

## Existing Architecture and Relevant Files

Anvil currently has a session-centric web workspace and a Forge backend using HTTP commands plus globally sequenced SSE events.

Key files:

- `apps/web/src/components/AppShell.tsx`
  - Selects the active session and derives the active project from it.
  - Directly composes header, timeline, interactions, and composer.
  - Must stop being the place where each new surface invents its own layout.
- `apps/web/src/components/Sidebar.tsx`
  - Project chips currently filter threads; they are not project navigation.
- `apps/web/src/lib/anvilClient.ts`
  - Owns client-local active session selection, bootstrap, session hydration, SSE, and caches.
- `apps/web/src/styles/shell.css`
  - Defines the current vertical workspace layout.
- `packages/protocol/src/index.ts`
  - Defines the shared HTTP/SSE protocol, snapshots, events, commands, and validators.
- `packages/state/src/index.ts`
  - Reduces durable Anvil events into snapshots.
- `apps/forge/src/http/server.ts`
  - Custom Node HTTP server, owner authentication, same-origin mutation checks, SSE, and static web serving.
  - It currently has no WebSocket upgrade handling.
- `apps/forge/src/runtime/sessionManager.ts`
  - Owns Pi subprocesses keyed by session. Terminal lifecycle must not be added to this class.
- `apps/forge/src/store/database.ts`
  - SQLite persistence, snapshots, commands, and global event journal.
- `apps/forge/src/main.ts`
  - Wires Forge services and shutdown.
- `apps/forge/src/config.ts`
  - Canonicalizes and allowlists project paths.
- `apps/web/vite.config.ts`
  - Proxies `/api` to Forge in development; WebSocket proxying will need explicit verification/configuration.
- `deploy/anvil-forge.service`
  - Uses `KillMode=control-group`; terminal children are intentionally killed when Forge stops.
- `apps/forge/src/pi/anvilInlineArtifact.ts`
- `apps/web/src/components/InlineHtmlArtifact.tsx`
  - If present in the integrated branch, these provide a starting point for safe HTML rendering. Extract reusable sandbox/rendering logic rather than duplicating it.

Before beginning this work, checkpoint or commit current changes. Several central files may already be under active development. Do not run multiple agents against `AppShell.tsx`, `packages/protocol/src/index.ts`, or `apps/forge/src/http/server.ts` at the same time.

## Shared Workspace Model

### Client location

Replace the assumption that every visible workspace must be identified only by `activeSessionId` with one client-local location:

```ts
type WorkspaceLocation = {
  projectId: string;
  sessionId: string | null;
};
```

Selecting a thread selects both its project and session. A project-only location permits terminal or file access even if that project has no thread.

This location is client-local and must not be globally journaled. Different devices may view different projects or threads simultaneously. `session.select` is already effectively client-local and a no-op on Forge.

Project filtering and project navigation are different concepts. The existing sidebar `projectFilter` must not implicitly become terminal ownership. Either introduce explicit project navigation or evolve the sidebar so project selection and “All threads” filtering are visibly distinct.

### Shared layout component

Create one layout component owned by the workspace foundation, conceptually:

```text
WorkspaceLayout
├── main: conversation/session content
├── bottom: project terminal surface
└── right: project resource surface
```

Do not let terminal or file feature agents directly restructure `AppShell` after this component exists.

### Desktop layout

Use nested resizable panel groups:

```text
┌──────────────────────────────────────┬──────────────────┐
│ Conversation / session content       │ Resource viewer  │
│                                      │                  │
├──────────────────────────────────────┤                  │
│ Project terminal surface             │                  │
└──────────────────────────────────────┴──────────────────┘
```

Recommended structure:

- Outer horizontal group: left workspace stack and optional right resource panel.
- Inner vertical group in the left stack: conversation and optional bottom terminal.
- The right resource panel remains full height while the terminal opens under the conversation.
- Hidden surfaces should not leave empty handles or minimum-size gaps.

Use the shadcn `Resizable` pattern, normally backed by `react-resizable-panels`, with `ResizablePanelGroup`, `ResizablePanel`, and `ResizableHandle`. The existing shadcn `Separator` is only a visual line and is not a draggable divider. The repository does not currently contain a resizable UI component, so add it deliberately rather than styling `Separator` into one.

Persisting exact panel dimensions is optional and not required for acceptance. Sensible defaults are sufficient.

### Mobile layout

Mobile must not squeeze conversation, terminal, and file preview into simultaneous panes.

Use a full-screen workspace mode:

```ts
type MobileWorkspaceSurface = "conversation" | "terminal" | "resource";
```

- Conversation remains the default.
- Opening a terminal or resource replaces the conversation body with a full-screen surface under a compact header.
- Back returns to the previous conversation/session.
- Mobile shows one terminal at a time using tabs or a terminal picker.
- Desktop split groups may be represented as tabs on mobile; they do not need to render simultaneously.
- Terminal processes continue running when their surface is hidden.

A Sheet may be used as an implementation primitive only if it behaves like a full-screen route. Do not use a partial-height bottom sheet for the terminal because the software keyboard leaves too little usable space.

### UI state ownership

Client-local, project-keyed UI state may include:

- Whether terminal surface is visible.
- Active terminal ID.
- Terminal tabs/groups and split orientation.
- Whether resource surface is visible.
- Open resource tabs and active resource.
- Mobile active surface.
- Optional panel dimensions.

Do not put these presentation details in the durable Pi session snapshot. Exact layout synchronization across devices is not a first-version requirement.

## Data Ownership

| Data | Owner | Scope | Persistence |
|---|---|---|---|
| Pi conversation | Forge | Session | SQLite/Pi session files |
| Workspace location | Client | Client/device | Local cache optional |
| Terminal process | Forge `TerminalManager` | Project + terminal ID | Runtime only |
| Terminal record/metadata | Forge terminal storage | Project + terminal ID | Minimal durable record; running state is downgraded to exited after restart |
| Terminal history | Forge terminal storage | Project + terminal ID | Bounded persistent file/storage |
| Terminal grouping/layout | Client | Project | Local storage optional |
| Open resource tabs | Client | Project | Local storage optional |
| File contents/metadata | Forge file service | Project + relative path | Read from workspace |
| Agent `openFile` result | Pi/tool timeline | Session event referencing project resource | Existing event history |

### Shared Forge project resolver

Terminal and file services must not copy `SessionManager`'s private project map or depend on a session to locate a project. Establish one narrow resolver during foundation work:

```ts
type ProjectResolver = {
  resolveProject(projectId: string): ProjectSummary | undefined;
};
```

The implementation may delegate to `ForgeEventService.projectSummary(projectId)`, which sees both configured and dynamically added projects. Inject this resolver into `TerminalManager` and `ProjectFileService`. Do not import or call private `SessionManager` state. All services must receive the canonical stored path from this boundary.

## Terminal Implementation

### Reference architecture

T3 Code provides a useful conceptual reference:

- `node-pty` backend adapter.
- Dedicated terminal manager.
- xterm.js web renderer.
- WebSocket RPC streams.
- Bounded persisted history.
- Metadata subscription separate from attached terminal output.
- Attach logic that subscribes before obtaining the initial snapshot, buffers live events, sends the snapshot, removes duplicates by sequence, and then flushes buffered events.

Do not copy T3 Code's thread scoping. Anvil terminal keys are always project-scoped.

### Dependencies

Expected dependencies:

- Forge: `node-pty` and a WebSocket server package such as `ws`.
- Web: `@xterm/xterm` and `@xterm/addon-fit`.
- Web layout: `react-resizable-panels` through the shadcn Resizable component pattern.

`node-pty` is a native module. Verify installation and build behavior on Forge's Node version and deployment architecture. Ensure the native module is not incorrectly bundled by tsup and that production installation includes its runtime files and spawn helper.

### Terminal manager

Add a new service, for example:

- `apps/forge/src/terminal/terminalManager.ts`
- `apps/forge/src/terminal/ptyAdapter.ts`
- `apps/forge/src/terminal/nodePtyAdapter.ts`
- `apps/forge/src/terminal/historyStore.ts`

The exact paths may follow existing repository conventions, but the manager must remain a sibling of `SessionManager`, not a child of it.

Key terminals by:

```text
projectId + terminalId
```

The manager owns:

- Opening a terminal.
- Listing project terminals.
- Attaching/detaching clients without stopping the PTY.
- Writing input.
- Resizing.
- Clearing history.
- Closing and restarting terminals.
- Broadcasting output to attached clients.
- Tracking status, PID, exit code/signal, title/label, dimensions, and event sequence.
- Process-group cleanup during terminal close and Forge shutdown.
- Bounded history persistence.
- Minimal durable terminal records containing project ID, terminal ID, creation/update timestamps, last status, and history location/version. Do not persist a claim that a PTY is still running across Forge restart.

Use a small SQLite table/migration for terminal records and keep high-volume history outside SQLite in mode-`0600` files. On startup, any record previously marked running is restored as exited/interrupted. Explicit close with history deletion removes both record and history; ordinary close may retain an exited record. Bound retained inactive records and document cleanup/retention.

Do not accept a client-provided arbitrary `cwd`. The client sends `projectId`; Forge resolves the project through the shared `ProjectResolver` and uses the canonical `ProjectSummary.path`.

All new panes begin at the project root. “Inherit the current shell directory” is out of scope because it requires shell integration and is not reliably discoverable from a PTY.

### Shell and environment

- Resolve the shell server-side from the Forge account's environment with safe fallbacks.
- Use `TERM=xterm-256color` or the value required by xterm.js compatibility.
- Start at the canonical project path.
- Do not allow the browser to choose an executable.
- Avoid logging terminal input; it may contain secrets.
- Persisted history may also contain secrets, so create files with mode `0600` under Anvil's private state directory and document retention.
- Starting in an allowlisted project is not filesystem sandboxing. Once a shell is open, the Forge operating-system account's permissions are the actual boundary. This is acceptable for the personal owner-only deployment but must be explicit.

### Limits

Set defensive limits in the first implementation:

- Maximum terminals per project, for example 8.
- Maximum visible panes in one desktop group, for example 4.
- Valid row/column ranges.
- Maximum input frame size, for example 64 KiB.
- Bounded output buffering and per-client backpressure.
- Bounded persisted history, initially around 5,000 lines with an additional byte cap.
- Bounded browser buffer, initially around 512 KiB per attached pane.

Exact values may be adjusted after testing but limits must exist.

### History and reconnect

Keeping a PTY alive is not enough; reconnect must restore visible context.

For each terminal:

1. Persist a bounded replayable history outside the Anvil event journal.
2. Give terminal runtime events a per-terminal sequence or epoch/offset.
3. On attach, subscribe to live output before reading the snapshot.
4. Buffer events received while the snapshot is prepared.
5. Send terminal metadata and bounded history as the initial snapshot.
6. Drop buffered events already represented by the snapshot sequence.
7. Flush remaining buffered events and continue live streaming.
8. If output was dropped because of backpressure, send a reset marker and a fresh bounded snapshot.

Terminal history does not need to reconstruct an exact alternate-screen application state after reconnect. Reasonable shell scrollback restoration is the first-version target. Full-screen applications such as Vim or `top` may need to redraw after reattachment.

After a Forge restart:

- PTY processes are gone because systemd kills the service control group.
- Persisted terminal records and bounded history remain.
- Records that were running are restored as exited/interrupted and are discoverable through the terminal metadata snapshot.
- Previously known terminal tabs may display an exited/restartable state.
- Do not silently claim that the process survived or automatically restart it.
- Do not add tmux in the first version.

If process survival across Forge restarts is required later, tmux or another supervisor must run in a separate lifecycle boundary. Merely spawning tmux from Forge will not survive the current `KillMode=control-group` service shutdown.

### Terminal transport

Add a dedicated, versioned WebSocket terminal channel. Keep existing HTTP/SSE behavior for Pi sessions.

A JSON message protocol is sufficient initially because `node-pty` and xterm.js already exchange strings. The terminal channel should support conceptual operations/events:

- `terminal.list`
- `terminal.open`
- `terminal.attach`
- `terminal.snapshot`
- `terminal.output`
- `terminal.write`
- `terminal.resize`
- `terminal.clear`
- `terminal.exit`
- `terminal.close`
- `terminal.restart`
- `terminal.error`
- `terminal.reset`

Use shared protocol types and runtime validation. The terminal protocol may have its own channel version while remaining part of the client-independent Anvil contract.

Keep new contracts modular instead of extending the already-large `packages/protocol/src/index.ts` indefinitely. Prefer dedicated modules such as `packages/protocol/src/terminal.ts` and `packages/protocol/src/resources.ts`, re-exported through the package entry point. Likewise, keep WebSocket upgrade/channel logic in a focused module such as `apps/forge/src/http/terminalWebSocket.ts`, with only a narrow registration/delegation hook in `ForgeHttpServer`.

Do not route high-volume terminal output through:

- `POST /api/v1/commands`
- the global SSE stream
- SQLite's global event journal
- the durable Anvil snapshot reducer

Terminal lifecycle metadata may be exposed through the terminal WebSocket snapshot/subscription. There is no need to journal every open/close/resize operation globally.

### WebSocket security

WebSocket upgrades must preserve the existing security model:

- Forge remains loopback-only.
- Tailscale Serve remains the remote exposure mechanism.
- Require the exact configured `tailscale-user-login` value on the upgrade request.
- Reject cross-origin upgrades using the same host/origin policy as mutating HTTP routes.
- Verify Tailscale Serve forwards owner identity on WebSocket upgrades.
- Verify the Vite `/api` proxy forwards WebSocket upgrades in development.
- Bound inbound frame sizes and outbound queues.
- Close slow consumers and allow them to reattach from a fresh snapshot.

For the personal single-user first version, multiple authenticated clients may attach to the same terminal, receive broadcast output, and send input. The most recent valid resize may define PTY dimensions. If simultaneous-device conflicts become a real problem, add an explicit controller/takeover lease later rather than blocking the first implementation.

### Terminal web UI

Create feature components outside `AppShell`, for example:

- `ProjectTerminalSurface`
- `TerminalViewport`
- `TerminalTabs`
- `TerminalGroup`
- `useProjectTerminals`
- `terminalClient`

`TerminalViewport` owns an xterm instance and fit addon. It must:

- Create and dispose xterm cleanly.
- Attach, apply snapshot history, then apply live output.
- Forward `onData` to terminal write.
- Observe its container and send debounced/coalesced resize events.
- Refit when desktop panels resize or mobile orientation changes.
- Avoid recreating the xterm instance for unrelated React renders.
- Respect app theme and accessible focus states.
- Intercept app shortcuts only when necessary and avoid stealing normal terminal key combinations.

Current global shortcuts in `AppShell.tsx`, including new-thread and numeric thread navigation, must be gated when terminal focus is active.

### Terminal groups and splits

Use a simple model initially:

```ts
type TerminalGroup = {
  id: string;
  terminalIds: string[];
  direction: "horizontal" | "vertical";
};
```

- A project may have multiple groups/tabs.
- The selected desktop group may show multiple equal panes.
- Mixed recursive/nested split trees are out of scope.
- Split dimensions do not need durable restoration.
- Mobile represents all terminals as tabs/picker items and shows one viewport.
- Reconcile client-local IDs with Forge metadata. Remove closed stale entries and expose running terminals discovered on Forge.

## Project Resource and File Implementation

### One generic open-resource action

Implement one client action used by every entry point:

```ts
openProjectResource(reference, source)
```

Use two explicit shapes at one mandatory enrichment boundary:

```ts
// Durable session-relative representation stored in the tool timeline.
// Its owning Anvil event/session supplies project identity.
type ProjectResourceContentBlock = {
  id: string;
  type: "projectResource";
  path: string; // project-relative
  view?: "auto" | "source" | "preview";
  line?: number;
  column?: number;
};

// Client navigation reference after enrichment.
type ProjectResourceReference = {
  projectId: string;
  path: string;
  view?: "auto" | "source" | "preview";
  line?: number;
  column?: number;
};
```

The canonical durable protocol representation is always `ProjectResourceContentBlock`; do not persist `projectId` in the tool block and do not use generic tool details as the client-facing contract. The client converts it through one helper such as `resolveProjectResourceReference(block, session)`, which copies `session.projectId`, before calling `openProjectResource`.

Entry points will include:

- Agent `anvil_open_file` tool.
- Future file tree.
- File search.
- Terminal path links.
- Timeline file references.
- Future diff/review surfaces.

The action opens or selects a tab in the shared right resource surface on desktop and activates the full-screen resource surface on mobile.

### Project-scoped file service

Create a dedicated Forge file service rather than extending `SessionManager.searchFiles` indefinitely.

The service resolves only:

```text
projectId + project-relative path
```

Forge derives the canonical root from its trusted project registry. Clients do not submit absolute roots.

Expected capabilities:

- Search project paths.
- List a directory for the future tree.
- Read regular file metadata and bounded content.
- Return media type, size, modification time, and an ETag/version.
- Optionally read a line range for large source files.
- Reject files above view limits with a clear downloadable/open-externally fallback where appropriate.

Potential routes, subject to repository conventions:

- `GET /api/v1/projects/:projectId/files/search?q=`
- `GET /api/v1/projects/:projectId/files/tree?path=`
- `GET /api/v1/projects/:projectId/files/content?path=`

Implement these routes in a focused module such as `apps/forge/src/http/projectFileRoutes.ts`, with narrow delegation from `ForgeHttpServer`.

File-content responses must be inert:

- Return source, Markdown, HTML, and other text as JSON containing UTF-8 text plus metadata; never serve project HTML as an executable same-origin document.
- HTML preview must consume that text and render it only through the sandboxed iframe/CSP pipeline.
- Allowlist raster image types such as PNG, JPEG, GIF, and WebP. Fetch them as authenticated bytes/blob URLs with `X-Content-Type-Options: nosniff` and a safe content disposition.
- Exclude SVG from direct image preview in the first version unless it is separately sanitized; SVG can contain active content.
- Never allow project JavaScript, HTML, or SVG responses to execute in the Anvil origin.

The current session-scoped `/api/v1/sessions/:id/files` search can remain temporarily for compatibility, but new UI must use project-scoped APIs and the old route should eventually delegate to the project file service.

### File security

Every file operation must:

- Decode and normalize the relative path safely.
- Reject absolute paths, NUL bytes, malformed encodings, and traversal.
- Resolve symlinks and verify the final canonical path remains inside the canonical project root.
- Require a regular file or directory as appropriate.
- Enforce byte and directory-entry limits.
- Avoid following a swapped symlink between validation and open where practical; use safe open flags and validate opened file metadata.
- Avoid serving workspace files through the static web root.
- Apply owner authentication and `no-store` caching unless an ETag strategy explicitly permits safe revalidation.

### Agent tool

Add a Pi extension tool following the existing Anvil extension/tool pattern:

```text
anvil_open_file
```

Parameters:

- `path`: required project-relative path.
- `view`: optional `auto`, `source`, or `preview`.
- `line`: optional positive line number.
- `column`: optional positive column number.

The tool must:

- Require a trusted project/workspace.
- Validate that the target is a regular file inside the project.
- Enforce a metadata/size check.
- Return a small normalized project-relative reference, not the entire file contents, in tool details with a fixed internal discriminator such as `kind: "anvil.open-file"`.
- Require the Pi RPC adapter/normalizer to convert that internal tool result into the canonical durable `ProjectResourceContentBlock` protocol variant.
- Produce a normal timeline representation that remains useful if the side panel is unavailable.

The current Pi tool context exposes the trusted `cwd`, not an Anvil `projectId`. The extension emits only normalized project-relative path plus view/line/column metadata. The Pi RPC adapter creates `ProjectResourceContentBlock` without a project ID. The web client then calls `resolveProjectResourceReference(block, session)` using the owning `SessionSummary.projectId` before `openProjectResource`. Do not make the extension guess project IDs, accept one from the model, or expose generic tool details directly to the resource UI.

Do not make historical timeline hydration repeatedly reopen old files. Auto-open only for a newly observed successful tool completion in the active client context. The timeline result must retain an explicit “Open file” action so a user reconnecting after the live event can open it manually.

The dedicated `projectResource` content block is required instead of an imperative `openFile` event. It can be durably rendered and manually opened by any client without replaying an old imperative UI command.

### Resource viewer

Create a shared `ProjectResourceSurface` with tabs and mode-specific viewers.

Initial modes:

1. Source/code
   - Read-only.
   - Syntax highlighting, line numbers, line targeting, selection, and horizontal scrolling.
   - Prefer CodeMirror 6 for a lightweight read-only viewer that can later support navigation and selections. Monaco is unnecessary unless full editing becomes a requirement.
2. Markdown
   - Reuse the existing `react-markdown` and `remark-gfm` stack.
   - Do not enable unsafe raw HTML by default.
3. HTML
   - Reuse/refactor the existing secure HTML iframe sandbox and CSP approach from `InlineHtmlArtifact` if available.
   - Scripts, navigation, external network resources, and unsafe event handlers remain blocked.
   - Self-contained HTML preview is the target; this is not a development server preview.
4. Images
   - Safe authenticated project-file response with bounded supported image formats.

`view: auto` selects the renderer from extension/media type. Unsupported or binary files show metadata and a clear unsupported-view state rather than decoding arbitrary bytes as text.

Initially refresh content when:

- The resource is opened.
- The user presses refresh.
- The client regains focus and the ETag changed.
- A new agent tool reference targets the same path.

A filesystem watcher and live refresh may be added later but should not block the first slice.

### Future file tree

The file tree is a later UI over the same project file service and `openProjectResource` action.

It should not require changes to terminal ownership, workspace layout, resource tabs, or the agent tool contract.

Future tree concerns:

- Lazy directory loading.
- Ignore rules and hidden-file preferences.
- Git/status decoration.
- File creation, rename, delete, and editing are separate privileged capabilities and remain out of scope until explicitly designed.

## Protocol and Naming Guidance

### Keep channels separate

- Existing Anvil protocol/snapshot/SSE: durable Pi/session state.
- Terminal WebSocket protocol: high-volume ephemeral terminal runtime plus attach snapshots.
- Project file HTTP API: bounded request/response content and tree/search metadata.
- Tool timeline reference: durable reference to a project resource, without embedding arbitrary file bytes.

### Existing `terminal` naming collision

`SessionSummary.lastTerminalSequence`, `lastTerminalOutcome`, and related variables currently use “terminal” to mean the final transition of a Pi run, not a shell terminal.

Before or during foundation work, strongly consider renaming them to unambiguous run terminology, for example:

- `lastRunCompletionSequence`
- `lastRunOutcome`
- `runCompletionSequences`

If a migration is too disruptive, all new shell APIs must consistently use `pty`, `shellTerminal`, or `projectTerminal` internally to avoid ambiguity. Do not introduce another unrelated `terminalSequence` concept without qualification.

## Implementation Phases and Agent Ownership

Each phase should land independently with tests and a coherent commit. Agents must not silently expand scope.

### Phase 0 — Checkpoint and contract review

Owner: lead/foundation agent.

Tasks:

- Ensure current work is committed or checkpointed.
- Read this document, `AGENTS.md`, current protocol, current Forge HTTP/event architecture, and current web shell.
- Confirm dependency versions compatible with current Node/React.
- Record any necessary deviations before implementation.

Acceptance:

- No feature code yet.
- Central file ownership and phase order are explicit.

### Phase 1 — Shared workspace foundation

Owner: one workspace foundation agent.

Scope:

- Add `WorkspaceLocation` client model.
- Separate project navigation from project filtering.
- Extract `WorkspaceLayout` from `AppShell` with typed main/bottom/right slots.
- Add shadcn Resizable primitives and responsive desktop/mobile behavior.
- Add minimal project-keyed UI surface state.
- Add the shared Forge `ProjectResolver` boundary used by later terminal and file services, backed by authoritative event/project state rather than `SessionManager`'s private map.
- Preserve existing conversation behavior with bottom/right surfaces absent.
- Optionally perform the run/terminal naming cleanup.

Do not implement terminal PTYs or file viewing in this phase.

Likely files:

- `apps/web/src/components/AppShell.tsx`
- New workspace layout/state components under `apps/web/src/`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/styles/shell.css`
- Responsive styles
- shadcn resizable component
- Client selection/cache tests

Acceptance:

- Existing sessions, timeline, interactions, and composer work unchanged.
- Desktop empty slots produce no gaps.
- Test placeholder bottom/right surfaces can be shown without restructuring `AppShell` again.
- Mobile can switch among placeholder conversation/terminal/resource surfaces.
- `corepack pnpm typecheck`, tests, and build pass.

### Phase 2 — Terminal backend and protocol

Owner: terminal backend agent.

Scope:

- Add terminal channel protocol and validators in a dedicated protocol module.
- Add focused WebSocket upgrade/channel handling with auth/origin checks rather than growing all channel logic inside `server.ts`.
- Add PTY adapter and project-scoped `TerminalManager`.
- Add bounded persistent history.
- Add attach snapshot/buffer/dedup logic.
- Wire startup/shutdown.
- Configure/test Vite and Tailscale assumptions.

Do not edit the shared layout except for any pre-agreed client transport hook types.

Acceptance:

- Multiple terminals can run under one project and remain independent of Pi sessions.
- Browser/WebSocket disconnection does not stop them.
- Reattach returns history then live output without an attach race.
- Project IDs resolve server-side to canonical roots.
- Slow clients and oversized frames are bounded.
- Forge shutdown terminates terminal process groups.
- Durable terminal records and history remain after a manager/Forge restart, metadata discovery reports the old PTY as exited/interrupted, and restart is explicit.
- Unit/integration tests cover lifecycle, reconnect, path ownership, auth, and cleanup.

### Phase 3 — Terminal web and mobile surfaces

Owner: terminal frontend agent.

Scope:

- Add xterm.js and fit addon.
- Implement terminal client connection/state.
- Implement project terminal tabs/groups/splits.
- Mount desktop UI only through `WorkspaceLayout.bottom`.
- Mount mobile UI only through the shared full-screen terminal surface.
- Gate conflicting app shortcuts while terminal is focused.
- Reconcile local terminal UI state with Forge metadata.

Do not redesign `WorkspaceLayout` or add a second drawer framework.

Acceptance:

- Switching threads in the same project preserves the same running terminals.
- Switching projects shows the other project's terminals.
- Reload/reconnect restores running terminal list and bounded history.
- Another device can attach to the same running terminal and see history/live output.
- Desktop splits work; mobile shows one terminal at a time.
- Keyboard input, paste, resize, focus, theme, close, restart, and exited states work.
- Tests and manual responsive checks pass.

### Phase 4 — Project file service

Owner: file backend agent.

Scope:

- Extract a project-scoped workspace file service.
- Add search, tree/list, and bounded inert-content endpoints through a focused route module.
- Add canonical containment and symlink defenses.
- Return metadata/media type/ETag.
- Adapt existing session file search to delegate where appropriate.

Do not implement the agent tool or side panel yet.

Acceptance:

- Files can be searched/read/listed by project ID and relative path.
- Traversal, absolute paths, outside-root symlinks, oversized files, and malformed paths are rejected.
- Authentication and response headers match Forge security rules.
- Tests cover normal and adversarial paths.

### Phase 5 — Resource surface and `openFile` tool

Owner: resource frontend/tool integration agent.

Scope:

- Implement the required `ProjectResourceContentBlock`, `ProjectResourceReference`, `resolveProjectResourceReference`, and `openProjectResource` boundary.
- Add project resource tabs/state.
- Implement source, Markdown, safe HTML, image, unsupported, loading, and error views.
- Mount only through `WorkspaceLayout.right` and the shared mobile resource surface.
- Add `anvil_open_file` Pi extension tool.
- Normalize/render the typed tool result.
- Reuse safe HTML rendering logic rather than duplicating it.

Acceptance:

- Agent can open a validated project file in the side view.
- Search/manual actions call the same client action.
- Source line targeting works.
- Markdown and HTML are safely rendered.
- Historical tool hydration does not unexpectedly reopen old files.
- Timeline retains a manual open action.
- Mobile uses a full-screen resource view.
- Tests, typecheck, and build pass.

### Phase 6 — File tree

Owner: file tree agent.

Scope:

- Build lazy project tree UI using the Phase 4 service.
- Open files only through `openProjectResource`.
- Integrate into the existing resource surface without changing layout ownership.

Acceptance:

- Tree expansion is lazy and bounded.
- Selecting a file opens/reuses a resource tab.
- Project switching changes the tree root.
- No editing or destructive filesystem actions are added.

### Phase 7 — Cross-feature hardening

Owner: integration/reviewer agent.

Scope:

- Cross-device and reconnect testing.
- Backpressure and process cleanup.
- Responsive and accessibility review.
- Security review of WebSocket, PTY, file paths, and HTML preview.
- Deployment validation under systemd and Tailscale Serve.
- Documentation updates.

## Parallelization Rules

Safe after Phase 1 contracts are merged:

- Terminal backend and project file backend may proceed in parallel if they do not edit the same protocol/server wiring files concurrently.
- Terminal viewport components and file viewer components may be developed independently before final mounting.

Not safe in parallel:

- Two agents editing `AppShell.tsx` or `WorkspaceLayout`.
- Two agents independently changing project navigation.
- Two agents changing `packages/protocol/src/index.ts` without a pre-agreed contract split.
- Two agents editing HTTP/WebSocket routing in `apps/forge/src/http/server.ts` simultaneously.
- Terminal UI and resource UI each adding their own responsive drawer/sheet system.

Prefer one foundation owner to merge central integration changes after feature components are ready.

## Agent Handoff Template

Give each implementation agent this document plus a phase-specific instruction using this structure:

```text
Read AGENTS.md and WORKSPACE_SURFACES_IMPLEMENTATION.md completely.
Implement only Phase N: <phase name>.
Inspect the current code before editing because earlier phases may have changed paths.
Respect the ownership boundaries and fixed product decisions in the document.
Do not redesign WorkspaceLayout or alter another phase's contracts without reporting the blocker first.
Add/adjust focused tests, run the relevant package tests, repository typecheck, and build.
At completion, report changed files, tests run, remaining risks, and any deviations from the document.
```

For review agents:

```text
Review Phase N against AGENTS.md and WORKSPACE_SURFACES_IMPLEMENTATION.md.
Focus on ownership/scoping, project-vs-session correctness, reconnect races,
resource cleanup, security boundaries, responsive behavior, and test coverage.
Do not implement unrelated improvements.
```

## Test Strategy

### Terminal backend

- Fake PTY adapter unit tests for open/write/resize/exit/close/restart.
- Multiple terminals under one project.
- Same terminal IDs under different projects remain isolated.
- Unknown project rejected.
- Canonical project root used regardless of client data.
- Attach snapshot/live-event race test.
- Sequence deduplication and reset behavior.
- Bounded history and history persistence.
- Slow consumer/backpressure behavior.
- SIGTERM then SIGKILL escalation and shutdown cleanup.
- WebSocket owner rejection, origin rejection, malformed frames, and size limits.

### Terminal web

- Project switching and same-project thread switching.
- Terminal metadata reconciliation.
- Snapshot then output rendering.
- Reconnect and reset.
- xterm disposal and no duplicate listeners.
- Resize coalescing.
- Shortcut behavior while terminal focused.
- Desktop group/split controls.
- Mobile one-pane behavior and return navigation.

### File backend

- Search/list/read normal files.
- Empty and nested directories.
- Traversal attempts.
- Absolute paths and malformed encodings.
- Symlink inside root and symlink escaping root.
- File-size and directory-entry limits.
- Binary/media detection and ETag/revalidation.
- Owner authorization.

### Resource viewer/tool

- Auto renderer selection.
- Read-only source and line targeting.
- Markdown sanitization.
- HTML sandbox/CSP/navigation/network restrictions.
- Unsupported/binary state.
- Resource tab reuse and project switching.
- Newly completed tool auto-opens once.
- Hydrated historical tool does not auto-open.
- Timeline manual open action.
- Mobile full-screen viewer.

### Manual cross-device acceptance

1. Open two terminals in Project A.
2. Run a long command in one terminal.
3. Close the browser completely.
4. Open Anvil on another device.
5. Select Project A and confirm both terminals are discoverable.
6. Attach and confirm bounded history plus current live output.
7. Switch between two Pi threads in Project A and confirm terminal identity does not change.
8. Switch to Project B and confirm its terminal workspace is isolated.
9. Ask Pi to call `anvil_open_file` for source, Markdown, and self-contained HTML files.
10. Confirm desktop side panel and mobile full-screen resource behavior.
11. Restart Forge and confirm terminal processes are accurately gone while persisted history remains available/restartable.

## Deployment and Operational Notes

- Update `docs/forge.md` with terminal dependency, history location, limits, and restart semantics.
- Verify `corepack pnpm build` does not incorrectly bundle `node-pty`.
- Verify production installation includes native runtime dependencies.
- Verify Tailscale Serve forwards WebSocket upgrades and identity headers.
- Keep Forge bound to loopback and never enable Funnel.
- Do not weaken `KillMode=control-group` to preserve terminal processes; doing so risks leaking Pi and shell subprocesses across service restarts.
- Include terminal history in backup/privacy documentation if it is persisted under Anvil state.

## Explicit Non-Goals

- Terminal process survival across Forge restarts.
- tmux integration.
- Exact cross-device split geometry synchronization.
- Arbitrary nested terminal split trees.
- Starting terminals in a browser-supplied arbitrary directory.
- Filesystem sandboxing beyond the Forge account's OS permissions.
- Full code editing or IDE behavior.
- File create/rename/delete operations.
- Executing arbitrary project HTML/JavaScript in the Anvil origin.
- Development-server preview orchestration.
- Public internet terminal access.

## Final Architecture Summary

The intended result is:

```text
Forge
├── SessionManager                 session-scoped Pi RPC
├── TerminalManager                project-scoped PTYs
├── TerminalHistoryStore           bounded project terminal history
├── ProjectFileService             project-scoped search/tree/read
├── HTTP + SSE                     durable Pi/session transport
└── authenticated WebSocket        terminal runtime transport

Web client
├── WorkspaceLocation              { projectId, sessionId? }
├── WorkspaceLayout
│   ├── ConversationSurface
│   ├── ProjectTerminalSurface
│   └── ProjectResourceSurface
├── openProjectResource()          shared action
├── xterm.js terminal renderer
└── source/Markdown/HTML viewers

Pi extension
└── anvil_open_file                emits validated project resource reference
```

The most important constraint is ownership: sessions own Pi conversations; projects own terminals and files; the shared workspace layout presents all three without conflating them.
