import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  GENERAL_PROJECT_ID,
  GENERAL_PROJECT_NAME,
  type ProjectSummary,
} from "@anvil/protocol";

import type { ForgeDatabase } from "../store/database.ts";

export function createGeneralProject(homeDirectory = homedir()): ProjectSummary {
  const path = realpathSync(resolve(homeDirectory));
  if (!statSync(path).isDirectory()) throw new Error(`Forge home is not a directory: ${path}`);
  return {
    id: GENERAL_PROJECT_ID,
    name: GENERAL_PROJECT_NAME,
    path,
    workspaceKind: "general",
  };
}

export function ensureGeneralProject(
  database: Pick<ForgeDatabase, "listProjects" | "syncProjects">,
  homeDirectory = homedir(),
): ProjectSummary {
  const project = createGeneralProject(homeDirectory);
  const projects = database.listProjects();
  const homeProject = projects.find((candidate) => candidate.path === project.path);
  if (homeProject) {
    const adopted = { ...project, id: homeProject.id };
    database.syncProjects([adopted]);
    return adopted;
  }
  const reservedProject = projects.find((candidate) => candidate.id === project.id);
  if (reservedProject) {
    throw new Error(`Project id ${project.id} is reserved for the General home workspace`);
  }
  database.syncProjects([project]);
  return project;
}

export function prepareGeneralProject(
  database: Pick<ForgeDatabase, "listProjects" | "seedConfigProjectsOnce" | "syncProjects">,
  configuredProjects: readonly ProjectSummary[],
  homeDirectory = homedir(),
): ProjectSummary {
  database.seedConfigProjectsOnce(configuredProjects);
  return ensureGeneralProject(database, homeDirectory);
}
