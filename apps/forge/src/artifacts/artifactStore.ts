import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { resolve, sep } from "node:path";

import type { UnsequencedAnvilEvent } from "@anvil/pi-rpc";
import type { ArtifactContentBlock, ArtifactReference, JsonValue } from "@anvil/protocol";

import type { ArtifactRecord } from "../store/database.ts";

const DEFAULT_INLINE_BYTES = 256 * 1024;
const MAX_DURABLE_EVENT_BYTES = 1024 * 1024;
const TEXT_PREVIEW_CHARS = 4_096;
const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ExternalizedEvents {
  events: UnsequencedAnvilEvent[];
  artifacts: ArtifactRecord[];
}

export class ArtifactStore {
  readonly root: string;

  constructor(
    root: string,
    private readonly inlineBytes = DEFAULT_INLINE_BYTES,
  ) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  externalize(events: readonly UnsequencedAnvilEvent[]): ExternalizedEvents {
    const artifacts: ArtifactRecord[] = [];
    const writtenIds: string[] = [];
    try {
      const transformed = events.map((event) => {
        if (!event.sessionId) return structuredClone(event);
        const sessionId = event.sessionId;
        const clone = structuredClone(event);
        if (clone.type === "message.delta" && Buffer.byteLength(clone.payload.delta, "utf8") > this.inlineBytes) {
          const originalDelta = clone.payload.delta;
          const bytes = Buffer.from(originalDelta, "utf8");
          const reference = this.write(
            sessionId,
            bytes,
            "text/plain; charset=utf-8",
            "message-delta.txt",
            artifacts,
            writtenIds,
          );
          clone.payload = {
            ...clone.payload,
            delta: "",
            artifact: {
              ...reference,
              id: `${clone.payload.blockId}-artifact`,
              type: "artifact",
              preview: originalDelta.slice(0, TEXT_PREVIEW_CHARS),
            },
          };
        }
        const value = this.transformValue(
          clone,
          sessionId,
          artifacts,
          writtenIds,
          0,
        );
        const serialized = JSON.stringify(value);
        if (typeof serialized !== "string") throw new Error("Normalized event is not JSON serializable");
        const serializedBytes = Buffer.byteLength(serialized, "utf8");
        if (serializedBytes > MAX_DURABLE_EVENT_BYTES) {
          throw new Error(`Normalized event remains too large after artifact externalization (${serializedBytes} bytes)`);
        }
        return value as unknown as UnsequencedAnvilEvent;
      });
      return { events: transformed, artifacts };
    } catch (error) {
      this.remove(writtenIds);
      throw error;
    }
  }

  ingest(
    sessionId: string,
    bytes: Buffer,
    mediaType: string,
    name: string,
  ): { reference: ArtifactReference; record: ArtifactRecord } {
    const artifacts: ArtifactRecord[] = [];
    const writtenIds: string[] = [];
    const reference = this.write(sessionId, bytes, mediaType, name, artifacts, writtenIds);
    const record = artifacts[0];
    if (!record) throw new Error("Attachment metadata was not created");
    record.purpose = "upload";
    return { reference, record };
  }

  pathFor(id: string): string | undefined {
    if (!ARTIFACT_ID.test(id)) return undefined;
    const path = resolve(this.root, id);
    return path.startsWith(`${this.root}${sep}`) ? path : undefined;
  }

  reconcile(records: readonly ArtifactRecord[]): string[] {
    const knownIds = new Set(records.map((record) => record.id));
    this.removeUnknown(knownIds);
    const invalid: string[] = [];
    for (const record of records) {
      const path = this.pathFor(record.id);
      try {
        if (!path) throw new Error("invalid path");
        const file = lstatSync(path);
        if (!file.isFile() || file.size !== record.byteLength) throw new Error("invalid file");
      } catch {
        invalid.push(record.id);
      }
    }
    return invalid;
  }

  remove(ids: readonly string[]): void {
    for (const id of ids) {
      const path = this.pathFor(id);
      if (!path) continue;
      try {
        rmSync(path, { force: true });
      } catch {
        // Artifact cleanup is best effort and retried by startup garbage collection.
      }
    }
  }

  removeUnknown(knownIds: ReadonlySet<string>): void {
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (entry.isDirectory() || knownIds.has(entry.name)) continue;
      const path = resolve(this.root, entry.name);
      if (path.startsWith(`${this.root}${sep}`)) rmSync(path, { force: true });
    }
  }

  private transformValue(
    value: unknown,
    sessionId: string,
    artifacts: ArtifactRecord[],
    writtenIds: string[],
    depth: number,
  ): JsonValue {
    if (value === undefined) return null;
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Normalized event contains a non-finite number");
      return value;
    }
    if (typeof value !== "object") throw new Error("Normalized event contains a non-JSON value");
    if (Array.isArray(value)) {
      return value.map((item) => this.transformValue(item, sessionId, artifacts, writtenIds, depth + 1));
    }

    const record = value as Record<string, unknown>;
    if (record.type === "artifact" || record.type === "artifactReference") {
      const trusted = typeof record.artifactId === "string" &&
        artifacts.some((artifact) => artifact.id === record.artifactId);
      if (!trusted) throw new Error("Pi emitted an untrusted artifact reference");
      return record as unknown as JsonValue;
    }

    if (record.type === "text" && typeof record.id === "string" && typeof record.text === "string") {
      const bytes = Buffer.from(record.text, "utf8");
      if (bytes.length > this.inlineBytes) {
        const artifact = this.write(sessionId, bytes, "text/plain; charset=utf-8", "tool-output.txt", artifacts, writtenIds);
        return {
          ...artifact,
          id: record.id,
          type: "artifact",
          preview: record.text.slice(0, TEXT_PREVIEW_CHARS),
        } satisfies ArtifactContentBlock as unknown as JsonValue;
      }
    }

    if (
      record.type === "image" &&
      typeof record.id === "string" &&
      typeof record.mimeType === "string" &&
      typeof record.data === "string"
    ) {
      const bytes = Buffer.from(record.data, "base64");
      if (bytes.length > this.inlineBytes) {
        const name = typeof record.name === "string" ? record.name : "image";
        const artifact = this.write(sessionId, bytes, record.mimeType, name, artifacts, writtenIds);
        const transformed: Record<string, unknown> = { ...record, url: artifact.url };
        delete transformed.data;
        return this.transformValue(transformed, sessionId, artifacts, writtenIds, depth + 1);
      }
    }

    if (record.type === "data" && typeof record.id === "string" && "data" in record) {
      const bytes = this.jsonBytes(record.data);
      if (bytes.length > this.inlineBytes) {
        const artifact = this.write(sessionId, bytes, "application/json", "structured-data.json", artifacts, writtenIds);
        return { ...artifact, id: record.id, type: "artifact" } satisfies ArtifactContentBlock as unknown as JsonValue;
      }
    }

    if (record.type === "unknown" && typeof record.id === "string" && "raw" in record) {
      const bytes = this.jsonBytes(record.raw);
      if (bytes.length > this.inlineBytes) {
        const artifact = this.write(sessionId, bytes, "application/json", "unknown-content.json", artifacts, writtenIds);
        return { ...artifact, id: record.id, type: "artifact" } satisfies ArtifactContentBlock as unknown as JsonValue;
      }
    }

    const transformed: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(record)) {
      if (item === undefined) continue;
      const externalizable = ["raw", "details", "arguments", "data"].includes(key) ||
        (key === "payload" && depth > 0);
      if (externalizable) {
        const bytes = this.jsonBytes(item);
        if (bytes.length > this.inlineBytes) {
          transformed[key] = this.write(
            sessionId,
            bytes,
            "application/json",
            `${key}.json`,
            artifacts,
            writtenIds,
          ) as unknown as JsonValue;
          continue;
        }
      }
      transformed[key] = this.transformValue(item, sessionId, artifacts, writtenIds, depth + 1);
    }
    return transformed;
  }

  private write(
    sessionId: string,
    bytes: Buffer,
    mediaType: string,
    name: string,
    artifacts: ArtifactRecord[],
    writtenIds: string[],
  ): ArtifactReference {
    const safeMediaType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:; charset=utf-8)?$/i.test(mediaType)
      ? mediaType
      : "application/octet-stream";
    const id = randomUUID();
    const path = this.pathFor(id);
    if (!path) throw new Error("Generated invalid artifact id");
    const temporaryPath = resolve(this.root, `.${id}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, path);
      const directoryDescriptor = openSync(this.root, constants.O_RDONLY);
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporaryPath, { force: true });
      rmSync(path, { force: true });
      throw error;
    }
    writtenIds.push(id);
    artifacts.push({
      id,
      sessionId,
      mediaType: safeMediaType,
      byteLength: bytes.length,
      name,
      purpose: "output",
      createdAt: new Date().toISOString(),
    });
    return {
      type: "artifactReference",
      artifactId: id,
      url: `/api/v1/artifacts/${id}`,
      mediaType: safeMediaType,
      byteLength: bytes.length,
      name,
    };
  }

  private jsonBytes(value: unknown): Buffer {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") throw new Error("Normalized event contains a non-JSON value");
    return Buffer.from(serialized, "utf8");
  }
}
