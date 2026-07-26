import type { ProjectSummary } from "@anvil/protocol";

import type { ForgeEventService } from "../events/eventService.ts";

export interface ProjectResolver {
  resolveProject(projectId: string): ProjectSummary | undefined;
}

export class EventProjectResolver implements ProjectResolver {
  constructor(private readonly events: ForgeEventService) {}

  resolveProject(projectId: string): ProjectSummary | undefined {
    return this.events.projectSummary(projectId);
  }
}
