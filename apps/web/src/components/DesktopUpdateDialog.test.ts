import { afterEach, describe, expect, it, vi } from "vitest";

import { desktopUpdaterError, isOcodeDesktop } from "./DesktopUpdateDialog";

afterEach(() => vi.unstubAllGlobals());

describe("desktopUpdaterError", () => {
  it("gives legacy desktop builds a concrete bootstrap instruction", () => {
    expect(desktopUpdaterError("plugin updater not found")).toContain("version 0.1.1");
    expect(desktopUpdaterError("updater.check not allowed by ACL")).toContain("replace the installed ocode app");
    expect(desktopUpdaterError("network unavailable")).toBe("network unavailable");
  });
});

describe("isOcodeDesktop", () => {
  it("only exposes native update controls in the macOS Tauri shell", () => {
    expect(isOcodeDesktop()).toBe(false);
    vi.stubGlobal("document", { documentElement: { dataset: { ocodeDesktop: "macos" } } });
    expect(isOcodeDesktop()).toBe(true);
  });
});
