import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PiCatalogService } from "./piCatalogService.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PiCatalogService", () => {
  it("lists bounded global Pi skills and extension entry points", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocode-pi-catalog-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "frontend"), { recursive: true });
    mkdirSync(join(root, "extensions", "browser"), { recursive: true });
    writeFileSync(join(root, "skills", "frontend", "SKILL.md"), "---\nname: frontend-design\ndescription: Design web interfaces.\n---\n# Skill\n");
    writeFileSync(join(root, "extensions", "browser", "index.ts"), "export default () => {};\n");
    writeFileSync(join(root, "extensions", "ignored.txt"), "nope\n");
    symlinkSync(join(root, "skills", "frontend"), join(root, "skills", "linked"));

    const catalog = await new PiCatalogService({ agentRoot: root }).catalog();

    expect(catalog).toMatchObject({
      skillsRoot: "~/.pi/agent/skills",
      extensionsRoot: "~/.pi/agent/extensions",
      skills: [{
        kind: "skill",
        name: "frontend-design",
        description: "Design web interfaces.",
        path: "~/.pi/agent/skills/frontend/SKILL.md",
      }],
      extensions: [{
        kind: "extension",
        name: "browser",
        path: "~/.pi/agent/extensions/browser/index.ts",
      }],
    });
  });

  it("returns empty lists when the Pi directories do not exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocode-pi-catalog-empty-"));
    roots.push(root);
    await expect(new PiCatalogService({ agentRoot: root }).catalog()).resolves.toMatchObject({ skills: [], extensions: [] });
  });
});
