import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SubagentInternalApi } from "./internalApi.ts";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("SubagentInternalApi", () => {
  it("requires its loopback capability token", async () => {
    const coordinator = {
      launch: vi.fn(() => ({ id: "run-1", childSessionId: "child-1", status: "queued" })),
      status: vi.fn(),
      cancel: vi.fn(),
    };
    const api = new SubagentInternalApi(coordinator as never, "http://127.0.0.1/internal");
    const parentEnvironment = api.environment({ session: { id: "parent-1", projectId: "project", title: "Parent", updatedAt: "now", status: "idle", modelId: "test/model", thinkingLevel: "off" } });
    expect(parentEnvironment).toMatchObject({
      OCODE_SUBAGENT_ENDPOINT: "http://127.0.0.1/internal",
      OCODE_PARENT_SESSION_ID: "parent-1",
    });
    expect(parentEnvironment.OCODE_SUBAGENT_TOKEN).toEqual(expect.any(String));
    const childEnvironment = api.environment({ session: { id: "child-1", projectId: "project", title: "Child", updatedAt: "now", status: "idle", modelId: "test/model", thinkingLevel: "off", internal: true } });
    expect(childEnvironment).toMatchObject({ OCODE_SUBAGENT_DISABLED: "1" });
    expect(childEnvironment.OCODE_SUBAGENT_TOKEN).toBeUndefined();
    expect(childEnvironment.OCODE_SUBAGENT_ENDPOINT).toBeUndefined();
    const server = createServer((request, response) => {
      void api.handle(request, response, new URL(request.url ?? "/", "http://localhost").pathname);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const url = `http://127.0.0.1:${address.port}/api/internal/v1/subagents`;
    const body = JSON.stringify({ action: "spawn", parentSessionId: "parent-1", parentToolCallId: "tool-1", task: "work" });

    expect((await fetch(url, { method: "POST", body })).status).toBe(403);
    expect((await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${parentEnvironment.OCODE_SUBAGENT_TOKEN}` },
      body: JSON.stringify({ action: "spawn", parentSessionId: "parent-2", parentToolCallId: "tool-1", task: "work" }),
    })).status).toBe(403);
    const accepted = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${parentEnvironment.OCODE_SUBAGENT_TOKEN}`, "content-type": "application/json" },
      body,
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ runId: "run-1", status: "queued" });
    expect(coordinator.launch).toHaveBeenCalledOnce();
  });
});
