import { describe, expect, it, vi } from "vitest";

import {
  OCODE_SUBAGENT_RPC_COMMAND,
  OCODE_SUBAGENT_RPC_REPLY_ENTRY,
  PiSubagentsClient,
} from "./piSubagentsClient.ts";

function replyRecord(data: unknown) {
  return {
    type: "entry_appended",
    entry: { type: "custom", customType: OCODE_SUBAGENT_RPC_REPLY_ENTRY, data },
  };
}

describe("PiSubagentsClient", () => {
  it("correlates a package reply delivered before Pi acknowledges the extension command", async () => {
    let client: PiSubagentsClient;
    const sendRequest = vi.fn(async (record: Record<string, unknown>) => {
      const encoded = String(record.message).slice(`/${OCODE_SUBAGENT_RPC_COMMAND} `.length);
      const request = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
        requestId: string;
        method: string;
        params: unknown;
      };
      expect(request).toMatchObject({ method: "ping", params: {} });
      expect(client.handleRecord(replyRecord({
        version: 1,
        requestId: request.requestId,
        method: "ping",
        success: true,
        data: { capabilities: { steer: true } },
      }))).toBe(true);
      return { type: "response", success: true };
    });
    client = new PiSubagentsClient({ sendRequest }, 1_000);

    await expect(client.request("ping")).resolves.toMatchObject({
      success: true,
      data: { capabilities: { steer: true } },
    });
  });

  it("returns an immediate Pi command rejection without waiting for the bridge timeout", async () => {
    const client = new PiSubagentsClient({
      sendRequest: vi.fn(async () => ({ type: "response", success: false, error: "command rejected" })),
    }, 10_000);

    await expect(Promise.race([
      client.request("status"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("still waiting")), 100)),
    ])).rejects.toThrow("command rejected");
  });

  it("invokes the package stop command for in-process workflows without involving the model", async () => {
    const sendRequest = vi.fn(async () => ({ type: "response", success: true }));
    const client = new PiSubagentsClient({ sendRequest });
    const runId = "11111111-1111-4111-8111-111111111111";

    await client.stopWorkflow(runId);

    expect(sendRequest).toHaveBeenCalledWith({ type: "prompt", message: `/subagents-stop ${runId}` });
  });

  it("consumes malformed internal replies without leaking them into the ordinary Pi timeline", () => {
    const client = new PiSubagentsClient({ sendRequest: vi.fn() });

    expect(client.handleRecord(replyRecord({ invalid: true }))).toBe(true);
    expect(client.handleRecord({ type: "entry_appended", entry: { type: "custom", customType: "other" } })).toBe(false);
  });

  it("rejects pending requests when the Pi runtime closes", async () => {
    const client = new PiSubagentsClient({ sendRequest: () => new Promise(() => undefined) }, 10_000);
    const request = client.request("status");

    client.close("runtime stopped");

    await expect(request).rejects.toThrow("runtime stopped");
  });
});
