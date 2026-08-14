import type { JsonValue, ToolEntry } from "@anvil/protocol";
import toolDisplayRules from "../config/tool-display-rules.json";

export type ToolCategory =
  | "file"
  | "edit"
  | "shell"
  | "search"
  | "browser"
  | "agent"
  | "image"
  | "git"
  | "parallel"
  | "generic";

export interface ToolPresentation {
  category: ToolCategory;
  title: string;
  detail: string;
  status: string;
}

type JsonRecord = { [key: string]: JsonValue };
type ToolStatusLabels = Record<ToolEntry["status"], string>;

interface CatalogPresentation {
  labels: ToolStatusLabels;
  detail: string;
}

interface ToolAliasRule extends CatalogPresentation {
  id: string;
  names: string[];
  category: ToolCategory;
  actions?: Record<string, CatalogPresentation>;
}

interface ShellDisplayRule extends CatalogPresentation {
  id: string;
  executables: string[];
  auxiliary?: boolean;
  category: ToolCategory;
  match: {
    all?: string[];
    any?: string[];
    none?: string[];
  };
}

interface ToolDisplayCatalog {
  version: number;
  toolAliases: ToolAliasRule[];
  shellRules: ShellDisplayRule[];
  shellMultiple: CatalogPresentation;
  shellFallback: CatalogPresentation;
}

const TOOL_STATUSES: ToolEntry["status"][] = ["queued", "running", "completed", "failed", "cancelled"];
const TOOL_CATEGORIES = new Set<ToolCategory>(["file", "edit", "shell", "search", "browser", "agent", "image", "git", "parallel", "generic"]);
const TEMPLATE_KEYS = new Set(["fileCountLabel"]);

function catalogRecord(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
  return value as Record<string, unknown>;
}

function catalogString(value: unknown, location: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${location} must be a non-empty string`);
  return value;
}

function validateTemplate(template: string, location: string): void {
  for (const match of template.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
    if (!TEMPLATE_KEYS.has(match[1]!)) throw new Error(`${location} uses unknown template key ${match[1]}`);
  }
}

function validateCatalogPresentation(value: unknown, location: string): CatalogPresentation {
  const source = catalogRecord(value, location);
  const labelSource = catalogRecord(source.labels, `${location}.labels`);
  const labels = {} as ToolStatusLabels;
  for (const status of TOOL_STATUSES) {
    labels[status] = catalogString(labelSource[status], `${location}.labels.${status}`);
    validateTemplate(labels[status], `${location}.labels.${status}`);
  }
  const detail = catalogString(source.detail, `${location}.detail`);
  validateTemplate(detail, `${location}.detail`);
  return { labels, detail };
}

function validateStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${location} must be a non-empty array`);
  return value.map((item, index) => catalogString(item, `${location}[${index}]`));
}

function validateCategory(value: unknown, location: string): ToolCategory {
  const category = catalogString(value, location) as ToolCategory;
  if (!TOOL_CATEGORIES.has(category)) throw new Error(`${location} contains unsupported category ${category}`);
  return category;
}

function validateDisplayCatalog(value: unknown): ToolDisplayCatalog {
  const source = catalogRecord(value, "tool display catalog");
  if (source.version !== 1) throw new Error("tool display catalog has an unsupported version");
  if (!Array.isArray(source.toolAliases) || !Array.isArray(source.shellRules)) {
    throw new Error("tool display catalog rules must be arrays");
  }

  const ids = new Set<string>();
  const aliases = new Set<string>();
  const claimId = (id: string, location: string) => {
    if (ids.has(id)) throw new Error(`${location} duplicates rule ID ${id}`);
    ids.add(id);
  };

  const toolAliases = source.toolAliases.map((value, index): ToolAliasRule => {
    const location = `toolAliases[${index}]`;
    const rule = catalogRecord(value, location);
    const id = catalogString(rule.id, `${location}.id`);
    claimId(id, location);
    const names = validateStringArray(rule.names, `${location}.names`).map((name) => name.toLowerCase());
    for (const name of names) {
      if (aliases.has(name)) throw new Error(`${location} duplicates alias ${name}`);
      aliases.add(name);
    }
    const base = validateCatalogPresentation(rule, location);
    const actions = rule.actions === undefined ? undefined : Object.fromEntries(
      Object.entries(catalogRecord(rule.actions, `${location}.actions`)).map(([action, presentation]) => [
        action.toLowerCase(),
        validateCatalogPresentation(presentation, `${location}.actions.${action}`),
      ]),
    );
    return { ...base, id, names, category: validateCategory(rule.category, `${location}.category`), actions };
  });

  const shellRules = source.shellRules.map((value, index): ShellDisplayRule => {
    const location = `shellRules[${index}]`;
    const rule = catalogRecord(value, location);
    const id = catalogString(rule.id, `${location}.id`);
    claimId(id, location);
    const matchSource = catalogRecord(rule.match, `${location}.match`);
    const match: ShellDisplayRule["match"] = {};
    for (const key of ["all", "any", "none"] as const) {
      if (matchSource[key] === undefined) continue;
      const patterns = validateStringArray(matchSource[key], `${location}.match.${key}`);
      for (const pattern of patterns) new RegExp(pattern, "i");
      match[key] = patterns;
    }
    if (!match.all?.length && !match.any?.length) throw new Error(`${location}.match needs all or any patterns`);
    return {
      ...validateCatalogPresentation(rule, location),
      id,
      executables: validateStringArray(rule.executables, `${location}.executables`).map((name) => name.toLowerCase()),
      auxiliary: rule.auxiliary === true || undefined,
      category: validateCategory(rule.category, `${location}.category`),
      match,
    };
  });

  return {
    version: 1,
    toolAliases,
    shellRules,
    shellMultiple: validateCatalogPresentation(source.shellMultiple, "shellMultiple"),
    shellFallback: validateCatalogPresentation(source.shellFallback, "shellFallback"),
  };
}

const displayCatalog = validateDisplayCatalog(toolDisplayRules);

function record(value: JsonValue): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function argument(entry: ToolEntry, key: string): string | undefined {
  return stringValue(record(entry.arguments)?.[key]);
}

function basename(name: string): string {
  const normalized = name.toLowerCase().split(/[.:/]/).at(-1);
  return normalized || name.toLowerCase();
}

function shorten(value: string, length = 96): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > length ? `${singleLine.slice(0, length - 1)}…` : singleLine;
}

function quoted(value: string): string {
  return `“${shorten(value, 68)}”`;
}

function host(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.hostname + (url.pathname === "/" ? "" : shorten(url.pathname, 36));
  } catch {
    return shorten(value, 52);
  }
}

function count(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

function toolAliasFor(name: string): ToolAliasRule | undefined {
  const normalized = name.toLowerCase();
  const shortName = basename(name);
  return displayCatalog.toolAliases.find((rule) => rule.names.includes(normalized) || rule.names.includes(shortName));
}

interface ShellInvocation {
  executable: string;
  text: string;
  words: string[];
}

function shellWords(value: string): string[] {
  return value.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g)?.map((word) => {
    const quotedWord = (word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'"));
    return quotedWord ? word.slice(1, -1) : word;
  }) ?? [];
}

function shellInvocations(command: string): ShellInvocation[] | undefined {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let comment = false;
  const flush = () => {
    if (current.trim()) segments.push(current.trim());
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    const next = command[index + 1];
    if (comment) {
      if (character === "\n") {
        comment = false;
        flush();
      }
      continue;
    }
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      else if (quote === '"' && character === "\\") escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "#" && (!current || /\s/.test(current.at(-1)!))) {
      comment = true;
      continue;
    }
    if (character === "`" || (character === "$" && next === "(") || (character === "<" && next === "<")) return undefined;
    if (character === "\n" || character === ";" || character === "&" || character === "|") {
      flush();
      if ((character === "&" || character === "|") && next === character) index += 1;
      continue;
    }
    current += character;
  }
  if (quote) return undefined;
  flush();

  const invocations: ShellInvocation[] = [];
  for (const segment of segments) {
    const words = shellWords(segment).filter((word) => !/^\d*[<>]/.test(word));
    let executableIndex = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[executableIndex] ?? "")) executableIndex += 1;
    if (words[executableIndex] === "env") {
      executableIndex += 1;
      while ((words[executableIndex] ?? "").startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[executableIndex] ?? "")) executableIndex += 1;
    }
    if (words[executableIndex] === "command") {
      executableIndex += 1;
      while ((words[executableIndex] ?? "").startsWith("-")) executableIndex += 1;
    }
    if (words[executableIndex] === "corepack") executableIndex += 1;
    const executableWord = words[executableIndex];
    if (!executableWord) continue;
    const executable = executableWord.split("/").filter(Boolean).at(-1)?.toLowerCase() ?? executableWord.toLowerCase();
    if (["bash", "dash", "eval", "sh", "zsh"].includes(executable) && words.slice(executableIndex + 1).includes("-c")) return undefined;
    const invocationWords = [executable, ...words.slice(executableIndex + 1)];
    invocations.push({ executable, text: invocationWords.join(" "), words: invocationWords });
  }
  return invocations;
}

function matchesPattern(pattern: string, invocations: ShellInvocation[]): boolean {
  const expression = new RegExp(pattern, "i");
  return invocations.some((invocation) => expression.test(invocation.text));
}

function matchingShellRules(invocations: ShellInvocation[]): ShellDisplayRule[] {
  return displayCatalog.shellRules.filter((rule) => {
    const candidates = invocations.filter((invocation) => rule.executables.includes(invocation.executable));
    if (!candidates.length) return false;
    const all = rule.match.all ?? [];
    const any = rule.match.any ?? [];
    const none = rule.match.none ?? [];
    return all.every((pattern) => matchesPattern(pattern, candidates))
      && (!any.length || any.some((pattern) => matchesPattern(pattern, candidates)))
      && none.every((pattern) => !matchesPattern(pattern, candidates));
  });
}

function gitAddFileLabel(invocations: ShellInvocation[] | undefined): string {
  const words = invocations?.find((invocation) => invocation.executable === "git" && /^git\s+add\b/i.test(invocation.text))?.words.slice(2);
  if (!words?.length) return "changes";
  const targets = words.filter((word) => !word.startsWith("-") && !/^\d*[<>]/.test(word));
  if (!targets.length || targets.some((word) => word === "." || word === "*")) return "changes";
  return plural(targets.length, "file");
}

function templateValues(invocations?: ShellInvocation[]): Record<string, string> {
  return { fileCountLabel: gitAddFileLabel(invocations) };
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return template
    .replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => values[key] ?? "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function catalogPresentation(
  entry: ToolEntry,
  presentation: CatalogPresentation,
  category: ToolCategory,
  values: Record<string, string>,
): ToolPresentation {
  return {
    category,
    title: fillTemplate(presentation.labels[entry.status], values),
    detail: fillTemplate(presentation.detail, values),
    status: statusText(entry),
  };
}

function categoryFor(entry: ToolEntry): ToolCategory {
  const name = entry.name.toLowerCase();
  if (name === "read") return "file";
  if (name === "edit" || name === "write") return "edit";
  if (name === "bash") return "shell";
  if (["search", "scrape", "ffgrep", "fffind"].includes(name)) return "search";
  if (name === "agent_browser") return "browser";
  if (name === "subagent") return "agent";
  if (name === "image") return "image";
  if (name === "bgst") return "git";
  if (name === "multi_tool_use.parallel") return "parallel";
  return "generic";
}

function duration(entry: ToolEntry): string | undefined {
  if (!entry.startedAt || !entry.endedAt) return undefined;
  const milliseconds = Date.parse(entry.endedAt) - Date.parse(entry.startedAt);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 10_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function statusText(entry: ToolEntry): string {
  const elapsed = duration(entry);
  if (entry.status === "queued") return "Queued";
  if (entry.status === "running") return "Running";
  if (entry.status === "failed") return elapsed ? `Failed · ${elapsed}` : "Failed";
  if (entry.status === "cancelled") return elapsed ? `Cancelled · ${elapsed}` : "Cancelled";
  return elapsed ? `Done · ${elapsed}` : "Done";
}

function tense(entry: ToolEntry, running: string, complete: string, neutral: string): string {
  if (entry.status === "running" || entry.status === "queued") return running;
  if (entry.status === "completed") return complete;
  return neutral;
}

function browserAction(entry: ToolEntry): string | undefined {
  const args = record(entry.arguments);
  const direct = stringValue(args?.action);
  if (direct) return direct;
  const positional = args?.args;
  return Array.isArray(positional) ? stringValue(positional[0]) : undefined;
}

function resultDetail(entry: ToolEntry): string | undefined {
  const details = entry.details === undefined ? undefined : record(entry.details);
  const resultCount = count(details?.count);
  if (resultCount !== undefined) return plural(resultCount, "result");
  const sourceCount = Array.isArray(details?.sources) ? details.sources.length : undefined;
  if (sourceCount !== undefined) return plural(sourceCount, "source");
  const imageCount = entry.output.filter((block) => block.type === "image").length;
  if (imageCount) return plural(imageCount, "image");
  return undefined;
}

export function displayToolName(name: string): string {
  if (name === "anvil_render_html_file") return "ocode_render_html_file";
  if (name === "anvil_open_file") return "ocode_open_file";
  return name;
}

export function presentTool(entry: ToolEntry): ToolPresentation {
  const alias = toolAliasFor(entry.name);
  const category = alias?.category ?? categoryFor(entry);
  const name = basename(entry.name);
  const path = argument(entry, "path");
  const outputDetail = resultDetail(entry);

  if (alias) {
    const action = argument(entry, "action")?.toLowerCase();
    const presentation = action ? alias.actions?.[action] ?? alias : alias;
    return catalogPresentation(entry, presentation, alias.category, templateValues());
  }

  if (category === "file") {
    const offset = count(record(entry.arguments)?.offset);
    const limit = count(record(entry.arguments)?.limit);
    const range = offset !== undefined
      ? limit !== undefined ? `Lines ${offset}–${offset + Math.max(0, limit - 1)}` : `From line ${offset}`
      : "File read";
    return {
      category,
      title: `${tense(entry, "Reading", "Read", "Read")} ${path ?? "file"}`,
      detail: range,
      status: statusText(entry),
    };
  }

  if (category === "edit") {
    const edits = record(entry.arguments)?.edits;
    const editCount = Array.isArray(edits) ? edits.length : undefined;
    const isWrite = name === "write";
    return {
      category,
      title: `${tense(entry, isWrite ? "Writing" : "Editing", isWrite ? "Wrote" : "Edited", isWrite ? "Write" : "Edit")} ${path ?? "file"}`,
      detail: editCount === undefined ? (isWrite ? "File write" : "File edit") : plural(editCount, "change"),
      status: statusText(entry),
    };
  }

  if (category === "shell") {
    const command = argument(entry, "command") ?? entry.summary;
    const invocations = shellInvocations(command);
    if (!invocations) return catalogPresentation(entry, displayCatalog.shellFallback, category, templateValues());
    const allMatches = matchingShellRules(invocations);
    const substantiveMatches = allMatches.filter((rule) => !rule.auxiliary);
    const matches = substantiveMatches.length ? substantiveMatches : allMatches;
    const combinedRule = matches.find((rule) => (rule.match.all?.length ?? 0) > 1);
    if (combinedRule) return catalogPresentation(entry, combinedRule, combinedRule.category, templateValues(invocations));
    if (matches.length === 1) return catalogPresentation(entry, matches[0]!, matches[0]!.category, templateValues(invocations));
    if (matches.length > 1) {
      const firstCategory = matches[0]!.category;
      const multipleCategory = matches.every((rule) => rule.category === firstCategory) ? firstCategory : category;
      return catalogPresentation(entry, displayCatalog.shellMultiple, multipleCategory, templateValues(invocations));
    }
    return catalogPresentation(entry, displayCatalog.shellFallback, category, templateValues(invocations));
  }

  if (category === "search") {
    const query = argument(entry, name === "ffgrep" ? "pattern" : "query") ?? argument(entry, "pattern");
    const url = argument(entry, "url");
    const isScrape = name === "scrape";
    const isFileSearch = name === "fffind" || name === "find";
    const isCodeSearch = name === "ffgrep" || name === "grep";
    const title = isScrape
      ? `${tense(entry, "Fetching", "Fetched", "Fetch")} ${host(url) ?? "page"}`
      : isFileSearch
        ? `${tense(entry, "Finding", "Found", "Find")} files${query ? ` for ${quoted(query)}` : ""}`
        : isCodeSearch
          ? `${tense(entry, "Searching", "Searched", "Search")} code${query ? ` for ${quoted(query)}` : ""}`
          : `${tense(entry, "Searching", "Searched", "Search")} the web${query ? ` for ${quoted(query)}` : ""}`;
    return {
      category,
      title,
      detail: outputDetail ?? (isScrape ? "Web page" : isFileSearch ? "File discovery" : isCodeSearch ? "Code search" : "Web search"),
      status: statusText(entry),
    };
  }

  if (category === "browser") {
    const action = browserAction(entry)?.toLowerCase() ?? "browse";
    const url = argument(entry, "url");
    const target = host(url);
    const verbs: Record<string, [string, string, string]> = {
      open: ["Opening", "Opened", "Open"],
      click: ["Clicking", "Clicked", "Click"],
      fill: ["Filling", "Filled", "Fill"],
      type: ["Typing", "Typed", "Type"],
      screenshot: ["Capturing", "Captured", "Capture"],
      snapshot: ["Inspecting", "Inspected", "Inspect"],
    };
    const [running, complete, neutral] = verbs[action] ?? ["Using", "Used", "Use"];
    const subject = action === "screenshot" ? "screenshot" : action === "snapshot" ? "page" : target ?? "browser";
    return {
      category,
      title: `${tense(entry, running, complete, neutral)} ${subject}`,
      detail: target && subject !== target ? target : "Agent Browser",
      status: statusText(entry),
    };
  }

  if (category === "agent") {
    const agent = argument(entry, "agent") ?? "Subagent";
    const task = argument(entry, "task");
    return {
      category,
      title: `${agent.charAt(0).toUpperCase()}${agent.slice(1)} agent`,
      detail: task ? shorten(task) : "Delegated task",
      status: statusText(entry),
    };
  }

  if (category === "image") {
    const prompt = argument(entry, "prompt");
    return {
      category,
      title: tense(entry, "Generating image", "Generated image", "Image generation"),
      detail: outputDetail ?? (prompt ? shorten(prompt) : "Image tool"),
      status: statusText(entry),
    };
  }

  if (category === "git") {
    const action = argument(entry, "action") ?? "status";
    const titles: Record<string, [string, string, string]> = {
      status: ["Checking repository", "Checked repository", "Repository status"],
      pull: ["Fetching remotes", "Fetched remotes", "Fetch remotes"],
      yeet: ["Publishing changes", "Published changes", "Publish changes"],
    };
    const [running, complete, neutral] = titles[action] ?? ["Running Git operation", "Finished Git operation", "Git operation"];
    return {
      category,
      title: tense(entry, running, complete, neutral),
      detail: action === "yeet" ? shorten(argument(entry, "message") ?? "Commit and push") : `Git · ${action}`,
      status: statusText(entry),
    };
  }

  if (category === "parallel") {
    const toolUses = record(entry.arguments)?.tool_uses;
    const toolCount = Array.isArray(toolUses) ? toolUses.length : undefined;
    return {
      category,
      title: tense(entry, "Running tools in parallel", "Finished parallel tools", "Parallel tools"),
      detail: toolCount === undefined ? "Parallel tool group" : plural(toolCount, "tool"),
      status: statusText(entry),
    };
  }

  const displayName = displayToolName(entry.name);
  return {
    category,
    title: entry.label ?? displayName,
    detail: entry.output.length ? `${displayName} · Output available` : `${displayName} · Extension tool`,
    status: statusText(entry),
  };
}
