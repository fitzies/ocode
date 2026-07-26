import { describe, expect, it } from "vitest";
import type { ConfigEnv, UserConfigFnObject } from "vite";

import config from "./vite.config";

describe("Vite Forge proxy", () => {
  it("forwards WebSocket upgrades on the API proxy", () => {
    const createConfig = config as UserConfigFnObject;
    const resolved = createConfig({ command: "serve", mode: "development", isSsrBuild: false, isPreview: false } satisfies ConfigEnv);
    expect(resolved.server?.proxy?.["/api"]).toMatchObject({ ws: true });
  });
});
