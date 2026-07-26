import type { ProjectFileMetadata } from "@anvil/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ProjectResourceTab } from "@/lib/workspace";
import { isCurrentResourceRequest, revalidateProjectResource } from "./resourceLoader";

const tab: ProjectResourceTab = {
  id: "README.md",
  projectId: "project-1",
  path: "README.md",
  view: "auto",
  openedFrom: "timeline",
};
const file = (etag: string): ProjectFileMetadata => ({
  path: tab.path,
  name: tab.path,
  kind: "file",
  size: 8,
  modifiedAt: "2026-07-23T01:00:00.000Z",
  etag,
  mediaType: "text/markdown; charset=utf-8",
  viewer: "markdown",
});
const previous = { status: "ready" as const, file: file('"one"'), text: "Old" };

describe("resource stale-while-revalidate", () => {
  it("retains usable content when the ETag is unchanged", async () => {
    const text = vi.fn();
    const result = await revalidateProjectResource(tab, previous, "focus", new AbortController().signal, {
      metadata: async () => file('"one"'),
      text,
    });
    expect(result).toEqual({ kind: "unchanged", state: previous });
    expect(text).not.toHaveBeenCalled();
  });

  it("loads changed content atomically", async () => {
    const changed = file('"two"');
    const result = await revalidateProjectResource(tab, previous, "focus", new AbortController().signal, {
      metadata: async () => changed,
      text: async () => ({ file: changed, text: "New" }),
    });
    expect(result).toEqual({ kind: "changed", state: { status: "ready", file: changed, text: "New" } });
  });

  it("reports failed checks to the caller without mutating previous content", async () => {
    await expect(revalidateProjectResource(tab, previous, "focus", new AbortController().signal, {
      metadata: async () => { throw new Error("offline"); },
      text: async () => { throw new Error("unreachable"); },
    })).rejects.toThrow("offline");
    expect(previous.text).toBe("Old");
  });

  it("rejects obsolete overlapping checks and checks aborted unmount requests", () => {
    const controller = new AbortController();
    expect(isCurrentResourceRequest(controller.signal, 2, 2)).toBe(true);
    expect(isCurrentResourceRequest(controller.signal, 1, 2)).toBe(false);
    controller.abort();
    expect(isCurrentResourceRequest(controller.signal, 2, 2)).toBe(false);
  });
});
