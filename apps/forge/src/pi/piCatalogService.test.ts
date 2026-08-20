import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("reads only bounded frontmatter while still listing a large skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocode-pi-large-skill-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "large"), { recursive: true });
    writeFileSync(join(root, "skills", "large", "SKILL.md"), `---\nname: large\ndescription: Large instructions.\n---\n\n${"x".repeat(600 * 1024)}`);
    const service = new PiCatalogService({ agentRoot: root });

    await expect(service.catalog()).resolves.toMatchObject({ skills: [{ id: "large/SKILL.md", name: "large" }] });
    await expect(service.read("skill", "large/SKILL.md")).rejects.toMatchObject({ code: "resource_too_large", status: 413 });
  });

  it("returns empty lists when the Pi directories do not exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocode-pi-catalog-empty-"));
    roots.push(root);
    await expect(new PiCatalogService({ agentRoot: root }).catalog()).resolves.toMatchObject({ skills: [], extensions: [] });
  });

  it("creates, saves, duplicates, renames, and deletes resources with conflict protection", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocode-pi-resource-mutations-"));
    roots.push(root);
    const service = new PiCatalogService({ agentRoot: root });

    const created = await service.createSkill("test-skill");
    expect(created.item).toMatchObject({ id: "test-skill/SKILL.md", name: "test-skill" });
    expect(created.text).toBe("---\nname: test-skill\ndescription: \"Instructions for test-skill.\"\n---\n\n# test-skill\n");
    await expect(service.saveSkill(created.item.id, "changed", "stale-etag")).rejects.toMatchObject({ code: "resource_changed", status: 409 });

    const saved = await service.saveSkill(created.item.id, `${created.text}\nMore instructions.\n`, created.etag);
    expect(saved.text).toContain("More instructions.");
    mkdirSync(join(root, "skills", "test-skill", "references"));
    writeFileSync(join(root, "skills", "test-skill", "references", "guide.md"), "Companion guide\n");

    const copied = await service.duplicateSkill(saved.item.id, "test-copy");
    expect(copied.item).toMatchObject({ id: "test-copy/SKILL.md", name: "test-copy" });
    expect(copied.text).toContain("name: test-copy");
    expect(readFileSync(join(root, "skills", "test-copy", "references", "guide.md"), "utf8")).toBe("Companion guide\n");

    const renamed = await service.renameSkill(copied.item.id, "test-renamed", copied.etag);
    expect(renamed.item).toMatchObject({ id: "test-renamed/SKILL.md", name: "test-renamed" });
    expect(readFileSync(join(root, "skills", "test-renamed", "references", "guide.md"), "utf8")).toBe("Companion guide\n");

    await service.deleteSkill(renamed.item.id, renamed.etag);
    expect(existsSync(join(root, "skills", "test-renamed"))).toBe(false);
    await expect(service.read("skill", renamed.item.id)).rejects.toMatchObject({ code: "resource_not_found", status: 404 });
  });

  it("rejects links while duplicating a complete skill package", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocode-pi-resource-links-"));
    roots.push(root);
    const service = new PiCatalogService({ agentRoot: root });
    const created = await service.createSkill("linked-skill");
    writeFileSync(join(root, "outside.txt"), "secret\n");
    symlinkSync(join(root, "outside.txt"), join(root, "skills", "linked-skill", "reference.txt"));

    await expect(service.duplicateSkill(created.item.id, "linked-copy")).rejects.toMatchObject({ code: "unsafe_skill_package", status: 415 });
    expect(existsSync(join(root, "skills", "linked-copy"))).toBe(false);
  });

  it("rejects a linked skills root", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocode-pi-linked-root-"));
    const outside = mkdtempSync(join(tmpdir(), "ocode-pi-linked-root-target-"));
    roots.push(root, outside);
    symlinkSync(outside, join(root, "skills"), "dir");
    const service = new PiCatalogService({ agentRoot: root });

    await expect(service.catalog()).resolves.toMatchObject({ skills: [] });
    await expect(service.createSkill("unsafe-skill")).rejects.toMatchObject({ code: "unsafe_resource_root", status: 415 });
    expect(existsSync(join(outside, "unsafe-skill"))).toBe(false);
  });

  it("serializes saves and renames so a stale rename cannot overwrite a save", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocode-pi-resource-serialization-"));
    roots.push(root);
    const service = new PiCatalogService({ agentRoot: root });
    const created = await service.createSkill("queued-skill");

    const [saved, renamed] = await Promise.allSettled([
      service.saveSkill(created.item.id, `${created.text}\nSaved first.\n`, created.etag),
      service.renameSkill(created.item.id, "queued-renamed", created.etag),
    ]);

    expect(saved.status).toBe("fulfilled");
    expect(renamed).toMatchObject({ status: "rejected", reason: { code: "resource_changed", status: 409 } });
    await expect(service.read("skill", created.item.id)).resolves.toMatchObject({ text: expect.stringContaining("Saved first.") });
  });
});
