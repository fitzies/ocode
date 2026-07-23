import { ANVIL_PROTOCOL_VERSION, isAnvilBootstrap, type AnvilCommandResponse } from "@anvil/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ForgeEventService } from "../events/eventService.ts";
import { ForgeDatabase } from "../store/database.ts";
import { ForgeHttpServer } from "./server.ts";

let database: ForgeDatabase;
let events: ForgeEventService;
let server: ForgeHttpServer;
let baseUrl: string;

beforeEach(async () => {
  database = new ForgeDatabase(":memory:");
  events = new ForgeEventService(database, [{ id: "anvil", name: "Anvil", path: "/repo" }]);
  server = new ForgeHttpServer({ events });
  await server.listen("127.0.0.1", 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await server.close();
  database.close();
});

describe("ForgeHttpServer", () => {
  it("serves a protocol bootstrap with its global cursor", async () => {
    events.append([{
      sessionId: null,
      timestamp: "2026-07-23T01:00:00.000Z",
      type: "connection.changed",
      payload: { connection: "connected" },
    }]);
    const response = await fetch(`${baseUrl}/api/v1/bootstrap`);
    const bootstrap: unknown = await response.json();
    expect(response.status).toBe(200);
    expect(isAnvilBootstrap(bootstrap)).toBe(true);
    expect(bootstrap).toMatchObject({ cursor: 1, snapshot: { lastSequence: 1 } });
  });

  it("replays and streams SSE events after a cursor", async () => {
    events.append([{
      sessionId: null,
      timestamp: "2026-07-23T01:00:00.000Z",
      type: "connection.changed",
      payload: { connection: "connected" },
    }]);
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/v1/events?after=0`, { signal: controller.signal });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected SSE body");
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("id: 1");
    expect(text).toContain("event: anvil");
    controller.abort();
  });

  it("enforces the configured Tailscale owner identity", async () => {
    await server.close();
    server = new ForgeHttpServer({ events, ownerLogin: "owner@example.com" });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    expect((await fetch(`${baseUrl}/api/v1/bootstrap`)).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/v1/bootstrap`, {
      headers: { "tailscale-user-login": "owner@example.com" },
    })).status).toBe(200);
  });

  it("validates commands before dispatch", async () => {
    await server.close();
    const handled: string[] = [];
    server = new ForgeHttpServer({
      events,
      handleCommand: async (command): Promise<AnvilCommandResponse> => {
        handled.push(command.id);
        return {
          protocolVersion: ANVIL_PROTOCOL_VERSION,
          id: "response-1",
          commandId: command.id,
          timestamp: command.timestamp,
          success: true,
          outcome: "completed",
        };
      },
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const command = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "command-1",
      sessionId: null,
      timestamp: "2026-07-23T01:00:00.000Z",
      type: "session.create",
      payload: { projectId: "anvil" },
    };
    const response = await fetch(`${baseUrl}/api/v1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    expect(response.status).toBe(200);
    expect(handled).toEqual(["command-1"]);

    const invalid = await fetch(`${baseUrl}/api/v1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...command, payload: {} }),
    });
    expect(invalid.status).toBe(400);
  });
});
