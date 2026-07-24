import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { RpcSubprocess } from "./subprocess.ts";

function nodeRpc(script: string, commandTimeoutMs = 1_000) {
  return new RpcSubprocess({
    executable: process.execPath,
    args: ["--input-type=module", "--eval", script],
    cwd: process.cwd(),
    commandTimeoutMs,
  });
}

describe("RpcSubprocess", () => {
  it("correlates responses while continuing to emit events", async () => {
    const rpc = nodeRpc(`
      import { createInterface } from "node:readline";
      const input = createInterface({ input: process.stdin });
      input.on("line", (line) => {
        const command = JSON.parse(line);
        process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "response", command: command.type, id: command.id, success: true }) + "\\n");
      });
    `);
    const records: Array<Record<string, unknown>> = [];
    rpc.on("record", (record) => records.push(record));
    rpc.start();

    const response = await rpc.sendRequest({ type: "get_state" });
    expect(response).toMatchObject({ type: "response", command: "get_state", success: true });
    expect(records[0]).toEqual({ type: "agent_start" });
    rpc.stop();
    await once(rpc, "exit");
  });

  it("rejects pending requests when stdout is malformed", async () => {
    const rpc = nodeRpc(`
      process.stdin.once("data", () => process.stdout.write("not-json\\n"));
      setInterval(() => {}, 1000);
    `);
    rpc.start();
    const protocolError = once(rpc, "protocolError");
    const request = rpc.sendRequest({ type: "get_state" });

    await expect(request).rejects.toThrow("malformed JSON");
    await protocolError;
    await once(rpc, "exit");
  });

  it("makes user-local tools available to Pi subprocesses", async () => {
    const rpc = new RpcSubprocess({
      executable: process.execPath,
      args: ["--input-type=module", "--eval", `
        import { createInterface } from "node:readline";
        const input = createInterface({ input: process.stdin });
        input.on("line", (line) => {
          const command = JSON.parse(line);
          process.stdout.write(JSON.stringify({
            type: "response",
            command: command.type,
            id: command.id,
            success: true,
            data: { path: process.env.PATH },
          }) + "\\n");
        });
      `],
      cwd: process.cwd(),
      env: { HOME: "/tmp/anvil-user", PATH: "/usr/bin" },
    });
    rpc.start();

    const response = await rpc.sendRequest({ type: "get_state" });
    expect(response).toMatchObject({
      data: { path: `/tmp/anvil-user/.local/bin${process.platform === "win32" ? ";" : ":"}/usr/bin` },
    });
    rpc.stop();
    await once(rpc, "exit");
  });

  it("times out an unanswered request", async () => {
    const rpc = nodeRpc("setInterval(() => {}, 1000);", 25);
    rpc.start();
    await expect(rpc.sendRequest({ type: "get_state" })).rejects.toThrow("timed out");
    rpc.stop();
    await once(rpc, "exit");
  });
});
