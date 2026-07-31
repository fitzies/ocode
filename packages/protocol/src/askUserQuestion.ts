import type { JsonValue } from "./content.js";

/** Exact editor title used to tunnel rich ask_user_question requests through Pi RPC. */
export const OCODE_ASK_USER_QUESTION_EDITOR_SENTINEL = "__ocode_ask_user_question_v1__" as const;
export const OCODE_ASK_USER_QUESTION_KIND = "ocode.ask-user-question" as const;
export const OCODE_ASK_USER_QUESTION_RESPONSE_KIND = "ocode.ask-user-question-response" as const;
export const OCODE_ASK_USER_QUESTION_SCHEMA_VERSION = 1 as const;

export type AskUserQuestionMode = "text" | "single-select" | "multi-select";

export interface OcodeAskUserQuestionOption {
  label: string;
  value: string;
  description?: string;
}

export interface OcodeAskUserQuestionEditorEnvelope {
  kind: typeof OCODE_ASK_USER_QUESTION_KIND;
  schemaVersion: typeof OCODE_ASK_USER_QUESTION_SCHEMA_VERSION;
  question: string;
  context?: string;
  mode: AskUserQuestionMode;
  options: OcodeAskUserQuestionOption[];
}

export type OcodeAskUserQuestionResponseAnswer =
  | { type: "text"; value: string }
  | { type: "option"; optionIndex: number }
  | { type: "other"; value: string };

export interface OcodeAskUserQuestionResponse {
  kind: typeof OCODE_ASK_USER_QUESTION_RESPONSE_KIND;
  schemaVersion: typeof OCODE_ASK_USER_QUESTION_SCHEMA_VERSION;
  answers: OcodeAskUserQuestionResponseAnswer[];
}

export interface AskUserQuestionPresentation {
  type: "ask_user_question";
  schemaVersion: typeof OCODE_ASK_USER_QUESTION_SCHEMA_VERSION;
  otherLabel?: string;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

/** Parse only the strict, versioned JSON prefill emitted by the bundled ocode extension. */
export function parseOcodeAskUserQuestionEditorEnvelope(value: unknown): OcodeAskUserQuestionEditorEnvelope | undefined {
  if (typeof value !== "string") return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return undefined;
  }
  const record = recordOf(decoded);
  if (
    !record ||
    !hasOnlyKeys(record, ["kind", "schemaVersion", "question", "context", "mode", "options"]) ||
    record.kind !== OCODE_ASK_USER_QUESTION_KIND ||
    record.schemaVersion !== OCODE_ASK_USER_QUESTION_SCHEMA_VERSION ||
    typeof record.question !== "string" ||
    (record.context !== undefined && typeof record.context !== "string") ||
    !["text", "single-select", "multi-select"].includes(String(record.mode)) ||
    !Array.isArray(record.options)
  ) return undefined;

  const options: OcodeAskUserQuestionOption[] = [];
  for (const value of record.options) {
    const option = recordOf(value);
    if (
      !option ||
      !hasOnlyKeys(option, ["label", "value", "description"]) ||
      typeof option.label !== "string" ||
      option.label.length === 0 ||
      typeof option.value !== "string" ||
      (option.description !== undefined && typeof option.description !== "string")
    ) return undefined;
    options.push({
      label: option.label,
      value: option.value,
      ...(option.description === undefined ? {} : { description: option.description }),
    });
  }

  const mode = record.mode as AskUserQuestionMode;
  if ((mode === "text") !== (options.length === 0)) return undefined;
  return {
    kind: OCODE_ASK_USER_QUESTION_KIND,
    schemaVersion: OCODE_ASK_USER_QUESTION_SCHEMA_VERSION,
    question: record.question,
    ...(record.context === undefined ? {} : { context: record.context }),
    mode,
    options,
  };
}

export function createOcodeAskUserQuestionResponse(
  answers: OcodeAskUserQuestionResponseAnswer[],
): OcodeAskUserQuestionResponse & JsonValue {
  return {
    kind: OCODE_ASK_USER_QUESTION_RESPONSE_KIND,
    schemaVersion: OCODE_ASK_USER_QUESTION_SCHEMA_VERSION,
    answers,
  };
}

/** Validate a client response against the original request and reject malformed data. */
export function parseOcodeAskUserQuestionResponse(
  value: unknown,
  request: OcodeAskUserQuestionEditorEnvelope,
): OcodeAskUserQuestionResponse | undefined {
  const record = recordOf(value);
  if (
    !record ||
    !hasOnlyKeys(record, ["kind", "schemaVersion", "answers"]) ||
    record.kind !== OCODE_ASK_USER_QUESTION_RESPONSE_KIND ||
    record.schemaVersion !== OCODE_ASK_USER_QUESTION_SCHEMA_VERSION ||
    !Array.isArray(record.answers)
  ) return undefined;

  const answers: OcodeAskUserQuestionResponseAnswer[] = [];
  const selectedIndexes = new Set<number>();
  let hasOther = false;
  for (const value of record.answers) {
    const answer = recordOf(value);
    if (!answer || typeof answer.type !== "string") return undefined;
    if (answer.type === "text") {
      if (!hasOnlyKeys(answer, ["type", "value"]) || typeof answer.value !== "string") return undefined;
      answers.push({ type: "text", value: answer.value });
      continue;
    }
    if (answer.type === "option") {
      if (
        !hasOnlyKeys(answer, ["type", "optionIndex"]) ||
        !Number.isSafeInteger(answer.optionIndex) ||
        Number(answer.optionIndex) < 0 ||
        Number(answer.optionIndex) >= request.options.length ||
        selectedIndexes.has(Number(answer.optionIndex))
      ) return undefined;
      const optionIndex = Number(answer.optionIndex);
      selectedIndexes.add(optionIndex);
      answers.push({ type: "option", optionIndex });
      continue;
    }
    if (answer.type === "other") {
      if (
        !hasOnlyKeys(answer, ["type", "value"]) ||
        typeof answer.value !== "string" ||
        !answer.value.trim() ||
        hasOther
      ) return undefined;
      hasOther = true;
      answers.push({ type: "other", value: answer.value });
      continue;
    }
    return undefined;
  }

  if (request.mode === "text") {
    if (answers.length !== 1 || answers[0]?.type !== "text") return undefined;
  } else if (request.mode === "single-select") {
    if (answers.length !== 1 || answers[0]?.type === "text") return undefined;
  } else if (answers.length === 0 || answers.some((answer) => answer.type === "text")) {
    return undefined;
  }
  return {
    kind: OCODE_ASK_USER_QUESTION_RESPONSE_KIND,
    schemaVersion: OCODE_ASK_USER_QUESTION_SCHEMA_VERSION,
    answers,
  };
}
