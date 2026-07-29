import { describe, expect, it } from "vitest";
import type { ConfigEnv, UserConfigFnObject } from "vite";

import config from "./vite.config";

describe("Vite Forge proxy", () => {
  it("forwards WebSocket upgrades on the API proxy", () => {
    const createConfig = config as UserConfigFnObject;
    const resolved = createConfig({ command: "serve", mode: "development", isSsrBuild: false, isPreview: false } satisfies ConfigEnv);
    expect(resolved.server?.proxy?.["/api"]).toMatchObject({ ws: true });
  });

  it("prefers the canonical development URL and accepts the legacy fallback", () => {
    const createConfig = config as UserConfigFnObject;
    const environment = { command: "serve", mode: "development", isSsrBuild: false, isPreview: false } satisfies ConfigEnv;
    try {
      process.env.ANVIL_DEV_FORGE_URL = "http://legacy:3210";
      let resolved = createConfig(environment);
      expect(resolved.server?.proxy?.["/api"]).toMatchObject({ target: "http://legacy:3210" });

      process.env.OCODE_DEV_FORGE_URL = "http://canonical:3210";
      resolved = createConfig(environment);
      expect(resolved.server?.proxy?.["/api"]).toMatchObject({ target: "http://canonical:3210" });
    } finally {
      delete process.env.OCODE_DEV_FORGE_URL;
      delete process.env.ANVIL_DEV_FORGE_URL;
    }
  });
});
