import { describe, expect, it } from "vitest";

import { ForgeEventService } from "../events/eventService.ts";
import { ForgeDatabase } from "../store/database.ts";
import { EventProjectResolver } from "./projectResolver.ts";

describe("EventProjectResolver", () => {
  it("resolves configured and dynamically added projects from authoritative event state", () => {
    const database = new ForgeDatabase(":memory:");
    const configured = { id: "configured", name: "Configured", path: "/srv/configured" };
    const events = new ForgeEventService(database, [configured]);
    const resolver = new EventProjectResolver(events);

    expect(resolver.resolveProject(configured.id)).toEqual(configured);
    expect(resolver.resolveProject("missing")).toBeUndefined();

    const dynamic = { id: "dynamic", name: "Dynamic", path: "/srv/dynamic" };
    events.createProject(dynamic, {
      sessionId: null,
      timestamp: "2026-07-25T10:00:00.000Z",
      type: "project.upserted",
      payload: { project: dynamic },
    });

    expect(resolver.resolveProject(dynamic.id)).toEqual(dynamic);
    database.close();
  });

  it("returns copies rather than mutable project state", () => {
    const database = new ForgeDatabase(":memory:");
    const project = { id: "project", name: "Project", path: "/srv/project" };
    const resolver = new EventProjectResolver(new ForgeEventService(database, [project]));

    const resolved = resolver.resolveProject(project.id)!;
    resolved.name = "Changed";

    expect(resolver.resolveProject(project.id)?.name).toBe("Project");
    database.close();
  });
});
