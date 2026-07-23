import { StringDecoder } from "node:string_decoder";

export interface JsonlDecoderOptions {
  maxRecordBytes?: number;
}

export class JsonlFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonlFramingError";
  }
}

/** Strict LF-delimited UTF-8 framing for Pi RPC stdout. */
export class JsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private readonly maxRecordBytes: number;
  private buffer = "";
  private finished = false;

  constructor(
    private readonly onRecord: (record: string) => void,
    options: JsonlDecoderOptions = {},
  ) {
    this.maxRecordBytes = options.maxRecordBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxRecordBytes) || this.maxRecordBytes <= 0) {
      throw new JsonlFramingError("maxRecordBytes must be a positive safe integer");
    }
  }

  push(chunk: Uint8Array | string): void {
    if (this.finished) throw new JsonlFramingError("Cannot push after the JSONL stream ended");
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    this.drainCompleteRecords();
    this.assertWithinLimit(this.buffer);
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.buffer += this.decoder.end();
    this.drainCompleteRecords();
    if (this.buffer.length > 0) {
      this.emit(this.buffer);
      this.buffer = "";
    }
  }

  private drainCompleteRecords(): void {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.emit(line);
    }
  }

  private emit(value: string): void {
    const record = value.endsWith("\r") ? value.slice(0, -1) : value;
    this.assertWithinLimit(record);
    if (record.length > 0) this.onRecord(record);
  }

  private assertWithinLimit(value: string): void {
    if (Buffer.byteLength(value, "utf8") > this.maxRecordBytes) {
      throw new JsonlFramingError(`JSONL record exceeds ${this.maxRecordBytes} bytes`);
    }
  }
}
