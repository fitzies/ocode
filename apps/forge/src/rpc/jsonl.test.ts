import { describe, expect, it } from "vitest";

import { JsonlDecoder, JsonlFramingError } from "./jsonl.ts";

describe("JsonlDecoder", () => {
  it("decodes fragmented UTF-8 records and optional CRLF", () => {
    const records: string[] = [];
    const decoder = new JsonlDecoder((record) => records.push(record));
    const bytes = Buffer.from('{"text":"forge ⚒"}\r\n{"value":2}\n');

    decoder.push(bytes.subarray(0, 17));
    decoder.push(bytes.subarray(17, 21));
    decoder.push(bytes.subarray(21));
    decoder.finish();

    expect(records).toEqual(['{"text":"forge ⚒"}', '{"value":2}']);
  });

  it("does not split valid JSON strings containing Unicode separators", () => {
    const records: string[] = [];
    const decoder = new JsonlDecoder((record) => records.push(record));
    decoder.push('{"text":"one\u2028two\u2029three"}\n');
    decoder.finish();
    expect(records).toEqual(['{"text":"one\u2028two\u2029three"}']);
  });

  it("emits a final unterminated record at EOF", () => {
    const records: string[] = [];
    const decoder = new JsonlDecoder((record) => records.push(record));
    decoder.push('{"final":true}');
    decoder.finish();
    expect(records).toEqual(['{"final":true}']);
  });

  it("rejects oversized records", () => {
    const decoder = new JsonlDecoder(() => undefined, { maxRecordBytes: 8 });
    expect(() => decoder.push("123456789")).toThrow(JsonlFramingError);
  });
});
