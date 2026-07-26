import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProjectResolver } from "./projectResolver.ts";
import {
  MAX_PROJECT_FILE_BYTES,
  ProjectFileError,
  ProjectFileService,
} from "./projectFileService.ts";

let root: string;
let outside: string;
let service: ProjectFileService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "anvil-files-root-"));
  outside = mkdtempSync(join(tmpdir(), "anvil-files-outside-"));
  const resolver: ProjectResolver = {
    resolveProject: (id) => id === "project-1" ? { id, name: "Project", path: root } : undefined,
  };
  service = new ProjectFileService(resolver);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("ProjectFileService", () => {
  it("reads nested metadata and transports text inertly", async () => {
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "guide.md"), "# Guide\n<script>alert(1)</script>\n");
    writeFileSync(join(root, "docs", "notes.markdown"), "# Notes\n");

    expect(await service.metadata("project-1", "docs/guide.md")).toMatchObject({
      path: "docs/guide.md",
      kind: "file",
      viewer: "markdown",
      mediaType: "text/markdown; charset=utf-8",
    });
    expect(await service.readText("project-1", "docs/guide.md")).toMatchObject({
      text: "# Guide\n<script>alert(1)</script>\n",
    });
    expect(await service.metadata("project-1", "docs/notes.markdown")).toMatchObject({
      viewer: "markdown",
      mediaType: "text/markdown; charset=utf-8",
    });
  });

  it.each(["/etc/passwd", "../outside", "docs/../secret", "C:/Windows/system.ini", "C:\\Windows\\system.ini", "bad\0path"])(
    "rejects unsafe project-relative path %s",
    async (path) => {
      await expect(service.metadata("project-1", path)).rejects.toBeInstanceOf(ProjectFileError);
    },
  );

  it("allows contained symlinks and rejects escaping symlinks", async () => {
    writeFileSync(join(root, "real.txt"), "inside");
    writeFileSync(join(outside, "secret.txt"), "outside");
    symlinkSync("real.txt", join(root, "inside.txt"));
    symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));

    await expect(service.readText("project-1", "inside.txt")).resolves.toMatchObject({ text: "inside" });
    await expect(service.readText("project-1", "escape.txt")).rejects.toMatchObject({ code: "path_outside_project" });
  });

  it("bounds file size", async () => {
    const oversized = join(root, "oversized.txt");
    writeFileSync(oversized, "");
    truncateSync(oversized, MAX_PROJECT_FILE_BYTES + 1);
    await expect(service.metadata("project-1", "oversized.txt")).rejects.toMatchObject({ code: "file_too_large" });
  });

  it("serves only allowlisted raster signatures and rejects SVG preview", async () => {
    writeFileSync(join(root, "pixel.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
    writeFileSync(join(root, "fake.png"), "<script>alert(1)</script>");
    writeFileSync(join(root, "active.svg"), "<svg onload=\"alert(1)\"></svg>");

    await expect(service.readRaster("project-1", "pixel.png")).resolves.toMatchObject({
      file: { mediaType: "image/png", viewer: "image" },
    });
    await expect(service.readRaster("project-1", "fake.png")).rejects.toMatchObject({ code: "invalid_media" });
    await expect(service.readRaster("project-1", "active.svg")).rejects.toMatchObject({ code: "unsupported_media" });
    await expect(service.readText("project-1", "active.svg")).resolves.toMatchObject({
      text: "<svg onload=\"alert(1)\"></svg>",
    });
  });

  it("holds raster concurrency leases until delivery releases them", async () => {
    writeFileSync(join(root, "pixel.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
    const leases = await Promise.all(Array.from({ length: 4 }, () => service.acquireRaster("project-1", "pixel.png")));
    await expect(service.acquireRaster("project-1", "pixel.png")).rejects.toMatchObject({ code: "media_busy" });
    leases[0]!.release();
    const replacement = await service.acquireRaster("project-1", "pixel.png");
    replacement.release();
    for (const lease of leases) lease.release();
  });

  it.runIf(process.platform !== "win32")("rejects FIFOs and escaping symlinks to FIFOs without blocking", async () => {
    execFileSync("mkfifo", [join(root, "pipe")]);
    execFileSync("mkfifo", [join(outside, "outside-pipe")]);
    symlinkSync(join(outside, "outside-pipe"), join(root, "escape-pipe"));
    await expect(Promise.race([
      service.metadata("project-1", "pipe"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("FIFO open blocked")), 1_000)),
    ])).rejects.toMatchObject({ code: "unsupported_file_type" });
    await expect(Promise.race([
      service.metadata("project-1", "escape-pipe"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("FIFO symlink open blocked")), 1_000)),
    ])).rejects.toMatchObject({ code: "path_outside_project" });
  });

  it("does not decode arbitrary binary data as text", async () => {
    writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    await expect(service.metadata("project-1", "binary.bin")).resolves.toMatchObject({ viewer: "unsupported" });
    await expect(service.readText("project-1", "binary.bin")).rejects.toMatchObject({ code: "binary_file" });
  });
});
