# Forge runtime

## Requirements

- Node.js 22.5 or newer; Node.js 24 LTS is recommended.
- A working C/C++ build toolchain for `node-pty` when a matching prebuild is unavailable.
- Pi installed and configured for the account running Forge.
- Every repository explicitly listed in the Forge configuration.
- Tailscale installed on Forge. Do not enable Funnel.

## Configuration

Copy `deploy/config.example.json` to `/home/forge/.config/ocode/config.json` and update `ownerLogin`, the Pi executable, and initial project paths. `ownerLogin` must exactly match the login forwarded by Tailscale Serve in `Tailscale-User-Login`; Forge rejects non-owner API requests when it is configured. Forge canonicalizes every configured project path at startup and rejects duplicate or missing directories.

Configured projects seed the trusted workspace registry. The authenticated owner can add another Forge-local directory from the Workspaces `+` control; Forge validates and canonicalizes the path, then persists it in SQLite across restarts. This is a privileged action because Pi receives full access inside that directory.

Environment overrides are documented in `.env.example`. Canonical `OCODE_*` and `VITE_OCODE_*` variables take precedence; legacy `ANVIL_*` and `VITE_ANVIL_*` names remain accepted as migration fallbacks. Fresh persistent data defaults to `/home/forge/.local/state/ocode`; keep that directory private and include the SQLite database, Pi session directory, artifact directory, and `terminal-history` directory in backups. `OCODE_TERMINAL_HISTORY_DIR` overrides the terminal history location. With no explicit path variable, Forge automatically continues using populated legacy config and state paths, even if an empty canonical state directory exists.

For an existing installation, do **not** copy the fresh-install `OCODE_DATA_DIR` example before moving state. Either omit explicit path variables and let compatibility detection use the legacy state, or point `OCODE_DATA_DIR` at the existing legacy directory. Move SQLite together with its `-wal`, `-shm`, and instance-lock sidecars, Pi sessions, artifacts, and terminal history only during a stopped-service migration. Keep the stable project `id`, but change a former `"name": "Anvil"` entry to `"name": "ocode"` so the workspace label updates without breaking session associations.

Project terminals are owner-authenticated shells running with the Forge operating-system account's permissions. Their initial working directory is always the canonical trusted project root; this is not a filesystem sandbox. Terminal history may contain commands, output, and secrets. It is retained in mode-`0600` files, bounded to 5,000 lines and 512 KiB per terminal, and deleted when the terminal tab is explicitly closed. Forge permits at most eight running terminals per project, 64 KiB input messages, and bounded WebSocket client queues.

Tool output, images, raw RPC records, or structured details larger than 256 KiB are externalized before they enter SQLite, snapshots, or SSE. Artifact files are mode `0600`, live outside the static web root, and are served only through the owner-authenticated `/api/v1/artifacts/:id` route. Deleting a thread removes its artifact metadata and files; startup removes files that have no durable metadata.

## Project file access and resource viewing

The read-only project file service resolves every request from an authenticated `projectId` and a normalized project-relative path. Forge obtains the canonical root from the trusted project registry, opens the target, resolves the opened file descriptor on Linux, and verifies that the final target remains inside that root. Project file access intentionally fails closed on non-Linux hosts because the portable pathname APIs cannot close parent-directory symlink races. Absolute paths, traversal, backslashes, control/NUL bytes, malformed URL encoding, escaping symlinks, special files, and unavailable projects are rejected. Filesystem opens are nonblocking so FIFOs cannot exhaust Forge workers. Resource metadata rejects files above 20 MiB, text reads stop at 1 MiB, and raster previews stop at 10 MiB with at most four delivery-scoped buffered responses.

Owner-authenticated routes are:

- `GET|HEAD /api/v1/projects/:projectId/files/metadata?path=` — regular-file metadata, media type, viewer hint, modification time, and ETag.
- `GET /api/v1/projects/:projectId/files/content?path=` — valid UTF-8 text in an inert JSON response.
- `GET|HEAD /api/v1/projects/:projectId/files/media?path=` — signature-checked PNG, JPEG, GIF, or WebP bytes with `nosniff`, sandbox CSP, no-store caching, and a safe disposition.

Project-file routes reject browser requests marked cross-site and emit `Cross-Origin-Resource-Policy: same-origin` in addition to exact owner authentication. Workspace files are never copied into or served from the static web root. Source, Markdown, HTML, JavaScript, XML, and SVG travel only as JSON text. HTML preview is reconstructed in a sandboxed opaque-origin iframe under a deny-by-default CSP; scripts, event handlers, forms, navigation, and external resources are blocked. SVG direct preview is intentionally unsupported. Unknown/binary files show metadata instead of being decoded.

The bundled `ocode_open_file` Pi tool requires a trusted workspace, accepts only project-relative paths, validates a bounded regular file, and returns navigation metadata without contents or a project ID. Pi RPC stores that result as a durable session-relative `projectResource` block. A newly streamed successful completion can open it once on the active client; restored or replayed history never imperatively reopens files, and every timeline result keeps a manual **Open file** action.

Resource tabs are client-local and project-scoped. There is no project file explorer or project-scoped tree/search API: resources open only from live agent requests or explicit timeline actions, including validated project-relative paths on successful write/edit tools. File viewing is read-only: editing, create/rename/delete, arbitrary binary download, SVG preview, development-server preview, and filesystem watching are not implemented. Changes are detected by ETag with stale-while-revalidate checks when a resource is refreshed or the client regains focus.

## Project Git action

The authenticated header action opens a project-scoped GitHub tab in the shared file side viewer. `GET /api/v1/projects/:projectId/git/status` returns a compact recent-commit summary plus per-file working-tree line counts; `GET /api/v1/projects/:projectId/git/commits` pages through the repository's full commit history in bounded batches. Provider-backed pull request and check status remains best effort. When changes exist, `POST /api/v1/projects/:projectId/git/generate-message` builds the proposed all-files commit in a temporary Git index and asks an ephemeral, tool-disabled Pi process for a subject line. `POST /api/v1/projects/:projectId/git/commit-and-push` accepts that subject and a fingerprint bound to the reviewed branch, HEAD, and proposed tree, rejects workspace drift, stages with `git add -A`, commits, and pushes only the checked-out branch with an explicit refspec. A clean branch with local commits skips generation and only pushes. Mutating routes require same-origin requests in addition to owner authentication.

The action never force-pushes or automatically pulls/rebases. It rejects detached HEADs, conflicts, missing or ambiguous remotes, concurrent project Git operations, and stale generated messages. If commit succeeds but push fails, the API reports that partial outcome so the client changes to a retryable **Push** action. Pi generation disables tools, extensions, skills, templates, themes, context files, and session persistence; the active thread contributes only its selected model.

Forge keeps a snapshot-backed tail of 100,000 journal events for reconnection and gradually compacts older rows during checkpoints. Clients whose cursor predates that tail receive a reset and restore from authoritative snapshots. Compaction makes SQLite pages reusable but does not immediately shrink the database file on disk.

## Development

```bash
corepack pnpm install
corepack pnpm build

# terminal 1
OCODE_CONFIG=/path/to/config.json OCODE_ALLOW_UNAUTHENTICATED=true corepack pnpm dev:forge

# terminal 2
VITE_OCODE_TRANSPORT=forge corepack pnpm dev:web
```

Vite proxies `/api` HTTP requests and WebSocket upgrades to `http://127.0.0.1:3210`. Without `VITE_OCODE_TRANSPORT=forge`, conversation development continues to use deterministic fixtures; project terminals require Forge.

The owner-authenticated `GET /api/v1/threads/search?q=` endpoint powers thread search. Queries are limited to 2–200 characters; Forge searches completed user-authored and assistant text, returns at most one bounded excerpt per ordinary thread and 50 matches overall, and never returns internal worker sessions.

Stop the system service before starting a development Forge that uses the same data directory. Forge takes an exclusive instance lock before opening SQLite, so a second process cannot mutate the journal even when it uses a different port. Use a separate `OCODE_DATA_DIR` when production and development instances must run at the same time.

## Service installation

Build and install ocode at `/opt/ocode`, then adapt `deploy/ocode-forge.service` if the Forge account or paths differ. Install the management command somewhere on the administrator's `PATH`:

```bash
sudo ln -sf /opt/ocode/bin/ocode /usr/local/bin/ocode
ocode status
```

`ocode start`, `stop`, `restart`, `rebuild`, `status`, and `logs` manage the service. `OCODE_URL` configures its backend URL, with `ANVIL_URL` accepted as a fallback. The command manages `ocode-forge` when that unit is installed and automatically falls back to an existing `anvil-forge` unit during migration. The legacy `bin/anvil` command remains as a warning compatibility shim. Status gives a compact service and Tailscale summary followed by every running Pi process on the host.

Install the systemd unit on a fresh host:

```bash
sudo install -m 0644 deploy/ocode-forge.service /etc/systemd/system/ocode-forge.service
sudo systemctl daemon-reload
sudo systemctl enable --now ocode-forge.service
sudo systemctl status ocode-forge.service
```

The unit reads `/etc/anvil/forge.env` first for migration compatibility and `/etc/ocode/forge.env` second so canonical values override legacy ones. It conflicts with the legacy unit as an additional guard against duplicate runtimes. It intentionally runs as the account that owns Pi configuration, credentials, sessions, and repositories. It binds only to loopback. Keep that restriction: forwarded Tailscale identity headers are trusted only because direct remote access to the backend is impossible.

On a host where `anvil-forge.service` is already active, adapt the new unit paths and environment first, then perform one explicit cutover. Do not use `enable --now` before the legacy unit is stopped:

```bash
sudo install -m 0644 deploy/ocode-forge.service /etc/systemd/system/ocode-forge.service
sudo systemctl daemon-reload
sudo systemctl stop anvil-forge.service
sudo systemctl disable anvil-forge.service
sudo systemctl enable --now ocode-forge.service
sudo systemctl status ocode-forge.service
```

After verifying health and state restoration, remove the old installed unit file if desired and run `sudo systemctl daemon-reload`. Never leave both units enabled: otherwise both may compete at boot even though the runtime lock and unit conflict protect normal starts.

## Tailscale exposure

Expose the loopback listener to the tailnet with Tailscale Serve and restrict the Forge device/service to the owner through tailnet ACLs:

```bash
sudo tailscale serve --bg http://127.0.0.1:3210
```

Verify the generated tailnet HTTPS URL from another authorized device. Do not use `tailscale funnel`, public port forwarding, or a non-loopback `OCODE_HOST`.

## Real Pi compatibility

Acceptance against Pi 0.80.10 found two live RPC events that are not listed in the RPC documentation's event table:

- `session_info_changed { name }` updates the ocode session title.
- `thinking_level_changed { level }` updates the selected thinking level.

Both shapes are covered by adapter fixtures. Unknown future records remain preserved as generic timeline events until their semantics are understood.

## Recovery semantics

Browser disconnects do not affect Pi. Protocol v3 loads lightweight thread summaries, paints the selected thread from a bounded local cache when available, synchronizes that thread through its global sequence watermark, and then continues on the single globally sequenced SSE stream. Forge remains authoritative.

Settled thread details are cached in memory for five minutes and persisted in IndexedDB. Streaming snapshots are not persisted. Cache corruption, protocol mismatch, deletion, or an invalid cursor falls back to an authoritative Forge detail reset.

After a Forge service restart, conversation history is rebuilt from SQLite and Pi session files. Commands left pending are marked unknown and are never replayed automatically. A persisted client prompt outbox retains drafts and stable command IDs, but surfaces unknown outcomes for user action instead of blindly duplicating side effects.

Because systemd owns the Pi and terminal subprocess control group, an in-flight run or PTY cannot be truthfully reattached after a full Forge service restart. Pi runs are marked interrupted, pending dialogs are cancelled, and the next command restores the durable Pi session into a clean runtime. Known terminal records and bounded history remain, but formerly running terminals are shown as interrupted and require an explicit restart. Browser disconnects do not interrupt Pi runs or PTYs; slow SSE/WebSocket consumers are bounded and reconnect from authoritative snapshots.

Settling a thread stops its Pi subprocess immediately. Unsettled runtimes that remain idle for 15 minutes are also stopped without changing the thread's visible settled state. A later prompt lazily restores the durable Pi session before continuing.
