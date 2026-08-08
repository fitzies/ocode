import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DesktopUpdateStore, compareDesktopVersions, publishDesktopRelease } from "./desktopUpdateStore.ts";

let directory: string;
let artifactPath: string;
let signaturePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ocode-desktop-updates-"));
  artifactPath = join(directory, "ocode.app.tar.gz");
  signaturePath = `${artifactPath}.sig`;
  writeFileSync(artifactPath, "signed desktop bundle");
  writeFileSync(signaturePath, "YWJjZA==\n");
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("DesktopUpdateStore", () => {
  it("orders stable and prerelease SemVer values", () => {
    expect(compareDesktopVersions("0.3.0", "0.2.9")).toBeGreaterThan(0);
    expect(compareDesktopVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareDesktopVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
    expect(compareDesktopVersions("1.0.0+build.2", "1.0.0+build.1")).toBe(0);
    expect(() => compareDesktopVersions("1.0.0-rc.01", "1.0.0-rc.1")).toThrow("valid SemVer");
  });

  it("atomically publishes and reopens the latest platform release", async () => {
    const metadata = publishDesktopRelease(directory, {
      artifactPath,
      signaturePath,
      version: "0.2.0",
      target: "darwin",
      arch: "aarch64",
      notes: "Drag and drop support",
      pubDate: "2026-08-08T00:00:00.000Z",
    });
    const store = new DesktopUpdateStore(directory);

    await expect(store.latest("darwin", "aarch64")).resolves.toEqual(metadata);
    const opened = await store.openArtifact("darwin", "aarch64", metadata.artifact);
    expect(opened?.byteLength).toBe(21);
    expect(await opened?.handle.readFile({ encoding: "utf8" })).toBe("signed desktop bundle");
    await opened?.handle.close();

    publishDesktopRelease(directory, {
      artifactPath,
      signaturePath,
      version: "0.3.0",
      target: "darwin",
      arch: "aarch64",
    });
    const previous = await store.openArtifact("darwin", "aarch64", metadata.artifact);
    expect(await previous?.handle.readFile({ encoding: "utf8" })).toBe("signed desktop bundle");
    await previous?.handle.close();
    expect(() => publishDesktopRelease(directory, {
      artifactPath,
      signaturePath,
      version: "0.2.5",
      target: "darwin",
      arch: "aarch64",
    })).toThrow("newer than published version 0.3.0");
    await expect(store.latest("darwin", "aarch64")).resolves.toMatchObject({ version: "0.3.0" });
  });

  it("rejects invalid metadata, platforms, signatures, and artifact traversal", async () => {
    expect(() => publishDesktopRelease(directory, {
      artifactPath,
      signaturePath,
      version: "not-semver",
      target: "darwin",
      arch: "aarch64",
    })).toThrow("SemVer");
    expect(() => publishDesktopRelease(directory, {
      artifactPath,
      signaturePath,
      version: "0.2.0+other-build",
      target: "darwin",
      arch: "aarch64",
    })).toThrow("build metadata");
    writeFileSync(signaturePath, "not a signature");
    expect(() => publishDesktopRelease(directory, {
      artifactPath,
      signaturePath,
      version: "0.2.0",
      target: "darwin",
      arch: "aarch64",
    })).toThrow("signature");

    writeFileSync(signaturePath, "YWJjZA==");
    publishDesktopRelease(directory, {
      artifactPath,
      signaturePath,
      version: "0.2.0",
      target: "darwin",
      arch: "aarch64",
    });
    expect(() => publishDesktopRelease(directory, {
      artifactPath,
      signaturePath,
      version: "0.2.0",
      target: "darwin",
      arch: "aarch64",
    })).toThrow("newer than published");

    const store = new DesktopUpdateStore(directory);
    await expect(store.latest("../../etc", "aarch64")).resolves.toBeUndefined();
    await expect(store.openArtifact("darwin", "aarch64", "../secret")).resolves.toBeUndefined();
  });
});
