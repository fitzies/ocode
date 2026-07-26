import { isProjectResourceContentBlock, type ProjectResourceContentBlock } from "./resources.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface TextContentBlock {
  id: string;
  type: "text";
  text: string;
}

export interface ImageContentBlock {
  id: string;
  type: "image";
  mimeType: string;
  alt?: string;
  name?: string;
  url?: string;
  data?: string;
}

export interface DataContentBlock {
  id: string;
  type: "data";
  label?: string;
  data: JsonValue;
}

export interface ToolCallContentBlock {
  id: string;
  type: "toolCall";
  toolCallId: string;
  name: string;
  arguments: JsonValue;
}

export interface UnknownContentBlock {
  id: string;
  type: "unknown";
  contentType: string;
  raw: JsonValue;
}

export interface ArtifactContentBlock {
  id: string;
  type: "artifact";
  artifactId: string;
  url: string;
  mediaType: string;
  byteLength: number;
  name?: string;
  preview?: string;
}

export interface ArtifactReference {
  type: "artifactReference";
  artifactId: string;
  url: string;
  mediaType: string;
  byteLength: number;
  name?: string;
}

export interface InlineHtmlContentBlock {
  id: string;
  type: "inlineHtml";
  title: string;
  html: string;
  sourcePath?: string;
  byteLength: number;
}

export type ContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | DataContentBlock
  | ToolCallContentBlock
  | UnknownContentBlock
  | ArtifactContentBlock
  | InlineHtmlContentBlock
  | ProjectResourceContentBlock;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasStrings(value: Record<string, unknown>, ...keys: string[]) {
  return keys.every((key) => typeof value[key] === "string");
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

export function isArtifactReference(value: unknown): value is ArtifactReference {
  return isRecord(value) &&
    value.type === "artifactReference" &&
    hasStrings(value, "artifactId", "url", "mediaType") &&
    value.url === `/api/v1/artifacts/${String(value.artifactId)}` &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value.artifactId)) &&
    Number.isSafeInteger(value.byteLength) && Number(value.byteLength) >= 0 &&
    (value.name === undefined || typeof value.name === "string");
}

export function isContentBlock(value: unknown): value is ContentBlock {
  if (!isRecord(value) || !hasStrings(value, "id", "type")) return false;
  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "image":
      return typeof value.mimeType === "string" &&
        (value.data === undefined || typeof value.data === "string") &&
        (value.url === undefined || typeof value.url === "string");
    case "data":
      return isJsonValue(value.data);
    case "toolCall":
      return hasStrings(value, "toolCallId", "name") && isJsonValue(value.arguments);
    case "unknown":
      return typeof value.contentType === "string" && isJsonValue(value.raw);
    case "artifact":
      return hasStrings(value, "artifactId", "url", "mediaType") &&
        /^\/[a-z0-9/_-]+$/i.test(String(value.url)) &&
        value.url === `/api/v1/artifacts/${String(value.artifactId)}` &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value.artifactId)) &&
        Number.isSafeInteger(value.byteLength) && Number(value.byteLength) >= 0 &&
        (value.name === undefined || typeof value.name === "string") &&
        (value.preview === undefined || typeof value.preview === "string");
    case "inlineHtml":
      return hasStrings(value, "title", "html") &&
        Number.isSafeInteger(value.byteLength) &&
        Number(value.byteLength) === new TextEncoder().encode(String(value.html)).byteLength &&
        Number(value.byteLength) <= 192 * 1024 &&
        (value.sourcePath === undefined || typeof value.sourcePath === "string");
    case "projectResource":
      return isProjectResourceContentBlock(value);
    default:
      return false;
  }
}
