import type { JsonValue, ToolEntry } from "@anvil/protocol";
import { ArrowUpRight01Icon, Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardHeader } from "@/components/ui/card";

export interface ToolContextSource {
  url: string;
  title: string;
  provenance: string;
}

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function safeWebUrl(value: JsonValue): URL | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

export function contextSourcesFromTool(entry: ToolEntry): ToolContextSource[] {
  const details = record(entry.details);
  const candidates = details && Array.isArray(details.sources) ? details.sources : [];
  const sources: ToolContextSource[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const url = safeWebUrl(candidate);
    if (!url || seen.has(url.href)) continue;
    seen.add(url.href);
    sources.push({
      url: url.href,
      title: url.hostname,
      provenance: `${url.pathname}${url.search}` || "/",
    });
    if (sources.length === 8) break;
  }
  return sources;
}

export function ToolContextCards({ sources }: { sources: ToolContextSource[] }) {
  if (!sources.length) return null;
  return (
    <div className="context-card-list" aria-label={`${sources.length} source ${sources.length === 1 ? "link" : "links"}`}>
      <div className="context-card-list-header">
        <strong>Sources</strong>
        <Badge variant="secondary">{sources.length}</Badge>
      </div>
      {sources.map((source) => (
        <Card className="context-card gap-0 py-0" key={source.url} size="sm">
          <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2.5 border-b border-border/70 px-3 py-2.5">
            <span className="context-card-icon" aria-hidden="true">
              <HugeiconsIcon icon={Globe02Icon} strokeWidth={2} className="size-3.5" />
            </span>
            <span className="context-card-copy">
              <strong>{source.title}</strong>
              <small>{source.provenance}</small>
            </span>
          </CardHeader>
          <CardFooter className="justify-end border-t border-border/70 px-2 py-1.5">
            <Button asChild variant="ghost" size="xs">
              <a href={source.url} target="_blank" rel="noreferrer" aria-label={`Open source: ${source.title}`}>
                Open source
                <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={2} className="size-3.5" />
              </a>
            </Button>
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}
