# ocode desktop

A minimal Tauri v2 shell for the Forge-served web app. It loads Forge directly as a remote HTTPS origin so the existing relative HTTP, SSE, and WebSocket connections keep the same origin. The trusted Forge page receives narrowly scoped native permissions for the integrated macOS title bar and signed desktop updates.

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

The Forge page remains same-origin with its HTTP, SSE, and WebSocket endpoints. Tailscale Serve—not the desktop app—adds the identity headers that Forge verifies. The title-bar capability is restricted to the main macOS window on the tailnet. At build time, `scripts/tauri.mjs` grants updater/restart commands only to the exact `OCODE_FORGE_URL` origin. Updates must also pass Tauri's embedded signature verification. The app exposes no filesystem, shell, or general network plugin. Do not broaden these capabilities without a separate security review.

## Signed desktop updates

The updater public key is embedded in `src-tauri/tauri.conf.json`. Its matching private key was generated once at `~/.config/ocode/desktop-updater.key` on Forge and must stay outside the repository. Securely copy that existing key to the same path on the Mac used for release builds and keep it mode `0600`. Do **not** generate a new key: clients with the embedded public key would reject its signatures. Rotating the key requires another manually installed bootstrap build.

The current key is deliberately passwordless for unattended personal release builds and depends on Forge/macOS file permissions for protection. A CI secret can instead provide `TAURI_SIGNING_PRIVATE_KEY` and, for an encrypted replacement key introduced during a bootstrap release, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

The desktop build wrapper injects both the Forge update endpoint and an exact-origin native capability from `OCODE_FORGE_URL`. Increase the version in both `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, then build on the target Mac:

```bash
OCODE_FORGE_URL=https://your-forge-host.example.ts.net corepack pnpm build:desktop
```

Tauri produces a signed `.app.tar.gz` updater payload and adjacent `.sig` file under `apps/desktop/src-tauri/target/release/bundle/macos/`. Copy those two files to Forge through the administration channel, build Forge so the publisher CLI is available, and publish them:

```bash
corepack pnpm build
corepack pnpm publish:desktop -- \
  --artifact /path/on/forge/ocode.app.tar.gz \
  --signature /path/on/forge/ocode.app.tar.gz.sig \
  --version 0.1.2 \
  --target darwin \
  --arch aarch64 \
  --notes "What changed"
```

Forge stores releases under `OCODE_DESKTOP_UPDATE_DIR`, defaulting to `~/.local/state/ocode/desktop-updates`, and serves them only to the authenticated Tailscale owner. Published versions and artifact URLs are immutable, and the Tauri signature remains the integrity boundary.

The first updater-enabled application must be installed manually: after building version `0.1.1` on the Mac, quit ocode and replace the installed application with `apps/desktop/src-tauri/target/release/bundle/macos/ocode.app` (or install the generated DMG), then reopen it. Later releases are available from **Settings → Desktop updates**.

## Commands

From the repository root:

```bash
corepack pnpm dev:desktop
corepack pnpm build:desktop
corepack pnpm check:desktop
corepack pnpm test:desktop
```

The normal `corepack pnpm build` remains the Forge and web build; it does not build desktop bundles.
