import { createPiRpcAdapterState, normalizeRecordedRpcItems } from "@anvil/pi-rpc";
import { expect, it } from "vitest";

import { fixtureById } from "./index";

it("records typed and malformed open-file results without losing fallback output", () => {
  const fixture = fixtureById.get("resource-open")!;
  const events = normalizeRecordedRpcItems(createPiRpcAdapterState({
    fixtureId: fixture.id,
    sessionId: fixture.session.id,
    baseTimestamp: fixture.baseTimestamp,
  }), fixture.records);
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: "tool.completed",
      payload: expect.objectContaining({ output: [expect.objectContaining({ type: "projectResource", path: "README.md" })] }),
    }),
    expect.objectContaining({
      type: "tool.completed",
      payload: expect.objectContaining({ output: [expect.objectContaining({ type: "text", text: "Malformed reference retained generically." })] }),
      raw: expect.anything(),
    }),
  ]));
});
