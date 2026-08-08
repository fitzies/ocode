import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const command = args[0];
const forgeValue = process.env.OCODE_FORGE_URL;
let forgeUrl;
if (forgeValue) {
  forgeUrl = new URL(forgeValue.trim());
  if (
    forgeUrl.protocol !== "https:" ||
    !forgeUrl.hostname.endsWith(".ts.net") ||
    forgeUrl.username || forgeUrl.password || forgeUrl.port ||
    !["", "/"].includes(forgeUrl.pathname) ||
    forgeUrl.search || forgeUrl.hash
  ) {
    throw new Error("OCODE_FORGE_URL must be a root https://*.ts.net origin");
  }
}

const tauriOverride = process.env.TAURI_CONFIG ? JSON.parse(process.env.TAURI_CONFIG) : {};
if (forgeUrl) {
  const endpoint = new URL("/api/v1/desktop/updates/{{target}}/{{arch}}/{{current_version}}", forgeUrl);
  tauriOverride.plugins = {
    ...tauriOverride.plugins,
    updater: {
      ...tauriOverride.plugins?.updater,
      endpoints: [endpoint.toString()],
    },
  };
  tauriOverride.app = {
    ...tauriOverride.app,
    security: {
      ...tauriOverride.app?.security,
      capabilities: [
        "window-drag",
        {
          identifier: "desktop-updater",
          description: "Allows the configured Forge origin to check, install, and restart after signed desktop updates.",
          windows: ["main"],
          platforms: ["macOS"],
          remote: { urls: [`${forgeUrl.origin}/*`] },
          permissions: [
            "core:app:allow-version",
            "core:resources:allow-close",
            "updater:allow-check",
            "updater:allow-download-and-install",
            "process:allow-restart",
          ],
        },
      ],
    },
  };
}

const environment = {
  ...process.env,
  TAURI_CONFIG: JSON.stringify(tauriOverride),
};
if (command === "build") {
  if (!forgeUrl) throw new Error("OCODE_FORGE_URL is required for updater-enabled desktop builds");
  if (!environment.TAURI_SIGNING_PRIVATE_KEY) {
    const keyPath = environment.TAURI_SIGNING_PRIVATE_KEY_PATH
      ?? join(homedir(), ".config", "ocode", "desktop-updater.key");
    if (!existsSync(keyPath)) {
      throw new Error(`Desktop updater signing key not found at ${keyPath}. Set TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH.`);
    }
    environment.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, "utf8").trim();
  }
  environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
}

if (command === "print-config") {
  process.stdout.write(`${environment.TAURI_CONFIG}\n`);
  process.exit(0);
}

const result = spawnSync("corepack", ["pnpm", "exec", "tauri", ...args], {
  cwd: new URL("..", import.meta.url),
  env: environment,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
