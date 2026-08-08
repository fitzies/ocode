import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UnsequencedAnvilEvent } from "@anvil/pi-rpc";
import { GENERAL_PROJECT_ID, GENERAL_PROJECT_NAME } from "@anvil/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { ForgeEventService } from "../events/eventService.ts";
import { ForgeDatabase } from "../store/database.ts";
import { createGeneralProject, ensureGeneralProject, prepareGeneralProject } from "./generalProject.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("General project", () => {
  it("creates the built-in folder workspace at the canonical Forge home", () => {
    const root = mkdtempSync(join(tmpdir(), "ocode-general-"));
    directories.push(root);
    const home = join(root, "home");
    mkdirSync(home);

    expect(createGeneralProject(home)).toEqual({
      id: GENERAL_PROJECT_ID,
      name: GENERAL_PROJECT_NAME,
      path: realpathSync(home),
      workspaceKind: "general",
    });
  });

  it("persists the workspace for existing Forge databases", () => {
    const root = mkdtempSync(join(tmpdir(), "ocode-general-"));
    directories.push(root);
    const home = join(root, "home");
    mkdirSync(home);
    const database = new ForgeDatabase(":memory:");

    const project = ensureGeneralProject(database, home);

    expect(database.listProjects()).toContainEqual({
      id: GENERAL_PROJECT_ID,
      name: GENERAL_PROJECT_NAME,
      path: project.path,
    });
    database.close();
  });

  it("adopts an already registered home directory without duplicating it", () => {
    const root = mkdtempSync(join(tmpdir(), "ocode-general-"));
    directories.push(root);
    const home = join(root, "home");
    mkdirSync(home);
    const database = new ForgeDatabase(":memory:");
    database.syncProjects([{ id: "existing-home", name: "Home", path: realpathSync(home) }]);

    const project = ensureGeneralProject(database, home);

    expect(project.id).toBe("existing-home");
    expect(database.listProjects()).toEqual([{
      id: "existing-home",
      name: GENERAL_PROJECT_NAME,
      path: realpathSync(home),
    }]);
    database.close();
  });

  it("adopts a configured home on a fresh database and restores its protection after restart", () => {
    const root = mkdtempSync(join(tmpdir(), "ocode-general-"));
    directories.push(root);
    const home = join(root, "home");
    mkdirSync(home);
    const databasePath = join(root, "forge.sqlite");
    const configured = [{ id: "configured-home", name: "Home", path: realpathSync(home) }];

    let database = new ForgeDatabase(databasePath);
    let project = prepareGeneralProject(database, configured, home);
    expect(project.id).toBe("configured-home");
    let events = new ForgeEventService(database, configured);
    events.markGeneralProject(project.id);
    expect(events.projectSummary(project.id)?.workspaceKind).toBe("general");
    events.checkpoint();
    database.close();

    database = new ForgeDatabase(databasePath);
    project = prepareGeneralProject(database, configured, home);
    events = new ForgeEventService(database, configured);
    events.markGeneralProject(project.id);
    expect(events.projectSummary(project.id)).toEqual(expect.objectContaining({
      id: "configured-home",
      name: GENERAL_PROJECT_NAME,
      workspaceKind: "general",
    }));
    expect(() => events.deleteProject(project.id, {
      type: "project.deleted",
      payload: { projectId: project.id },
      sessionId: null,
      timestamp: new Date().toISOString(),
    } as UnsequencedAnvilEvent)).toThrow("The General home workspace cannot be removed");
    database.close();
  });
});
