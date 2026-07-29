# ocode desktop

A minimal Tauri v2 shell for the Forge-served web app. It loads Forge directly as a remote HTTPS origin so the existing relative HTTP, SSE, and WebSocket connections keep the same origin. The remote page is not granted any Tauri capabilities or IPC permissions.

## Prerequisites

- A Rust toolchain and the repository's Node.js/Corepack/pnpm toolchain.
- Tailscale installed and connected to the same tailnet as Forge.
- Forge exposed with Tailscale Serve at an HTTPS URL accessible from this computer. Funnel/public exposure is not required or recommended.
- Install the [official Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for the operating system that will build the app. Desktop bundles are normally built on each target OS.
- On Ubuntu, install the documented libraries plus `pkg-config` (required by the Rust GTK bindings on this host):

  ```bash
  sudo apt update
  sudo apt install libwebkit2gtk-4.1-dev \
    build-essential \
    curl \
    wget \
    file \
    pkg-config \
    libxdo-dev \
    libssl-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev
  ```

If Rust was installed with rustup, make it available in the current shell with:

```bash
source "$HOME/.cargo/env"
```

## Forge URL

Set `OCODE_FORGE_URL` to the full Tailscale Serve HTTPS origin. It must be a `*.ts.net` origin with no credentials, path, query, fragment, or nonstandard port. No hostname is built in.

```bash
OCODE_FORGE_URL=https://your-forge-host.example.ts.net corepack pnpm dev:desktop
```

At runtime, the desktop process reads `OCODE_FORGE_URL`. Applications launched from a desktop icon may not inherit shell environment variables, so packaged builds should embed it by setting the same variable while compiling:

```bash
OCODE_FORGE_URL=https://your-forge-host.example.ts.net corepack pnpm build:desktop
```

A missing or invalid value opens a local setup page instead. The hostname embedded in a build is visible to anyone with that build, although it does not contain Tailscale credentials.

The Forge page remains same-origin with its HTTP, SSE, and WebSocket endpoints. Tailscale Serve—not the desktop app—adds the identity headers that Forge verifies. The desktop shell defines no plugins or capability files, and `capabilities: []` leaves the remote page without Tauri IPC permissions. Do not add a capability with `remote.urls` without a separate security review.

## Commands

From the repository root:

```bash
corepack pnpm dev:desktop
corepack pnpm build:desktop
corepack pnpm check:desktop
corepack pnpm test:desktop
```

The normal `corepack pnpm build` remains the Forge and web build; it does not build desktop bundles.
