import type { JsonValue, ToolEntry } from "@anvil/protocol";

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
  const category = categoryFor(entry);
  const name = basename(entry.name);
  const path = argument(entry, "path");
  const outputDetail = resultDetail(entry);

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
    return { category, title: shorten(command, 110), detail: "Shell command", status: statusText(entry) };
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
