import type { PiCatalogItem } from "@anvil/protocol";
import { describe, expect, it } from "vitest";

import { filterPiCatalogItems, piCatalogLocation, piCatalogResourcePath } from "./PiCatalogPage";

const items: PiCatalogItem[] = [
  {
    kind: "skill",
    id: "frontend/SKILL.md",
    name: "frontend-design",
    description: "Design web interfaces.",
    path: "~/.pi/agent/skills/frontend/SKILL.md",
    modifiedAt: "2026-07-23T01:00:00.000Z",
  },
  {
    kind: "skill",
    id: "release-notes.md",
    name: "release-notes",
    path: "~/.pi/agent/skills/release-notes.md",
    modifiedAt: "2026-07-23T01:00:00.000Z",
  },
];

describe("Pi catalog navigation", () => {
  it("round trips nested resource ids through detail URLs", () => {
    const pathname = piCatalogResourcePath("skill", "frontend/SKILL.md");
    expect(pathname).toBe("/pi/skills/frontend%2FSKILL.md");
    expect(piCatalogLocation(pathname)).toEqual({ kind: "skill", resourceId: "frontend/SKILL.md" });
  });

  it("encodes unusual discovered paths without changing their ids", () => {
    const pathname = piCatalogResourcePath("extension", "my extension/index.ts");
    expect(pathname).toBe("/pi/extensions/my%20extension%2Findex.ts");
    expect(piCatalogLocation(pathname)).toEqual({ kind: "extension", resourceId: "my extension/index.ts" });
  });

  it("treats the legacy catalog URL as the skills library", () => {
    expect(piCatalogLocation("/pi")).toEqual({ kind: "skill" });
    expect(piCatalogLocation("/pi/extensions")).toEqual({ kind: "extension" });
  });
});

describe("Pi catalog filtering", () => {
  it("searches names, descriptions, and display paths", () => {
    expect(filterPiCatalogItems(items, "WEB").map((item) => item.id)).toEqual(["frontend/SKILL.md"]);
    expect(filterPiCatalogItems(items, "release-notes.md").map((item) => item.id)).toEqual(["release-notes.md"]);
    expect(filterPiCatalogItems(items, "   ")).toEqual(items);
  });
});
