import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export class ProjectsRootValidationError extends Error {}

export function canonicalizeProjectsRoot(requestedPath: string): string {
  const input = requestedPath.trim();
  if (!input) throw new ProjectsRootValidationError("Projects root path is required");
  if (!isAbsolute(input)) throw new ProjectsRootValidationError("Projects root must be an absolute path");

  let path: string;
  try {
    path = realpathSync(resolve(input));
  } catch {
    throw new ProjectsRootValidationError("Projects root does not exist or is not accessible");
  }

  try {
    if (!statSync(path).isDirectory()) {
      throw new ProjectsRootValidationError("Projects root must be a directory");
    }
  } catch (error) {
    if (error instanceof ProjectsRootValidationError) throw error;
    throw new ProjectsRootValidationError("Projects root does not exist or is not accessible");
  }

  try {
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw new ProjectsRootValidationError("Projects root must be readable, writable, and accessible");
  }
  return path;
}
