import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveProjectFavicon } from "./projectFavicon.ts";

const directories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("resolveProjectFavicon", () => {
  it("prefers conventional favicon locations", async () => {
    const root = await temporaryDirectory("anvil-favicon-");
    await mkdir(join(root, "public"));
    await writeFile(join(root, "public", "favicon.svg"), "<svg />");

    await expect(resolveProjectFavicon(root)).resolves.toMatchObject({
      body: Buffer.from("<svg />"),
      mediaType: "image/svg+xml",
    });
  });

  it("resolves an Expo icon from app.json", async () => {
    const root = await temporaryDirectory("anvil-expo-icon-");
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "app-icon.png"), "png");
    await writeFile(join(root, "app.json"), JSON.stringify({ expo: { icon: "./assets/app-icon.png" } }));

    await expect(resolveProjectFavicon(root)).resolves.toMatchObject({
      body: Buffer.from("png"),
      mediaType: "image/png",
    });
  });

  it("discovers an icon in a monorepo application workspace", async () => {
    const root = await temporaryDirectory("anvil-monorepo-icon-");
    await mkdir(join(root, "apps", "web", "public"), { recursive: true });
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n");
    await writeFile(join(root, "apps", "web", "public", "favicon.svg"), "<svg>web</svg>");

    await expect(resolveProjectFavicon(root)).resolves.toMatchObject({
      body: Buffer.from("<svg>web</svg>"),
      mediaType: "image/svg+xml",
    });
  });

  it("resolves icon links and rejects icons outside the workspace", async () => {
    const root = await temporaryDirectory("anvil-linked-icon-");
    const outside = await temporaryDirectory("anvil-outside-icon-");
    await mkdir(join(root, "public"));
    await writeFile(join(root, "index.html"), '<link href="/brand.svg" rel="icon">');
    await writeFile(join(root, "public", "brand.svg"), "<svg />");
    expect((await resolveProjectFavicon(root))?.body.toString()).toBe("<svg />");

    await rm(join(root, "public", "brand.svg"));
    await writeFile(join(outside, "secret.svg"), "<svg />");
    await symlink(join(outside, "secret.svg"), join(root, "public", "brand.svg"));
    await expect(resolveProjectFavicon(root)).resolves.toBeNull();
  });
});
