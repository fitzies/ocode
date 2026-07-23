# Forge runtime

## Requirements

- Node.js 22.5 or newer; Node.js 24 LTS is recommended.
- Pi installed and configured for the account running Forge.
- Every repository explicitly listed in the Forge configuration.
- Tailscale installed on Forge. Do not enable Funnel.

## Configuration

Copy `deploy/config.example.json` to `/home/forge/.config/anvil/config.json` and update `ownerLogin`, the Pi executable, and initial project paths. `ownerLogin` must exactly match the login forwarded by Tailscale Serve in `Tailscale-User-Login`; Forge rejects non-owner API requests when it is configured. Forge canonicalizes every configured project path at startup and rejects duplicate or missing directories.

Configured projects seed the trusted workspace registry. The authenticated owner can add another Forge-local directory from the Workspaces `+` control; Forge validates and canonicalizes the path, then persists it in SQLite across restarts. This is a privileged action because Pi receives full access inside that directory.

Environment overrides are documented in `.env.example`. Persistent data defaults to `/home/forge/.local/state/anvil`; keep that directory private and include the SQLite database and Pi session directory in backups.

## Development

```bash
corepack pnpm install
corepack pnpm build

# terminal 1
ANVIL_CONFIG=/path/to/config.json ANVIL_ALLOW_UNAUTHENTICATED=true corepack pnpm dev:forge

# terminal 2
VITE_ANVIL_TRANSPORT=forge corepack pnpm dev:web
```

Vite proxies `/api` to `http://127.0.0.1:3210`. Without `VITE_ANVIL_TRANSPORT=forge`, development continues to use deterministic fixtures.

## Service installation

Build and install Anvil at `/opt/anvil`, then adapt `deploy/anvil-forge.service` if the Forge account or paths differ:

```bash
sudo install -m 0644 deploy/anvil-forge.service /etc/systemd/system/anvil-forge.service
sudo systemctl daemon-reload
sudo systemctl enable --now anvil-forge.service
sudo systemctl status anvil-forge.service
```

The service intentionally runs as the account that owns Pi configuration, credentials, sessions, and repositories. It binds only to loopback. Keep that restriction: forwarded Tailscale identity headers are trusted only because direct remote access to the backend is impossible.

## Tailscale exposure

Expose the loopback listener to the tailnet with Tailscale Serve and restrict the Forge device/service to the owner through tailnet ACLs:

```bash
sudo tailscale serve --bg http://127.0.0.1:3210
```

Verify the generated tailnet HTTPS URL from another authorized device. Do not use `tailscale funnel`, public port forwarding, or a non-loopback `ANVIL_HOST`.

## Real Pi compatibility

Acceptance against Pi 0.80.10 found two live RPC events that are not listed in the RPC documentation's event table:

- `session_info_changed { name }` updates the Anvil session title.
- `thinking_level_changed { level }` updates the selected thinking level.

Both shapes are covered by adapter fixtures. Unknown future records remain preserved as generic timeline events until their semantics are understood.

## Recovery semantics

Browser disconnects do not affect Pi. The client reloads a snapshot and resumes the globally sequenced SSE stream.

After a Forge service restart, conversation history is rebuilt from SQLite and Pi session files. Commands left pending are marked unknown and are never replayed automatically. Any in-flight run or extension dialog is considered interrupted; preserving active stdio across runtime crashes is Phase 3 work.
