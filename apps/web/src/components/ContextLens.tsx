import {
  OCODE_CONTEXT_CATEGORY_IDS,
  OCODE_CONTEXT_CATEGORY_LABELS,
  reconcileContextCategories,
  type ContextManifestV1,
  type OcodeContextCategoryId,
} from "@anvil/protocol";

import { memo, useCallback, useEffect, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface ContextUsageView {
  percent: number | null;
  percentLabel: string;
  usedLabel: string;
  remainingLabel: string;
  windowLabel: string;
  filledCells: number;
  tone: "default" | "warning" | "danger";
}

const MAP_CELLS = 50;

const CATEGORY_COLOR_CLASSES: Record<OcodeContextCategoryId, string> = {
  system: "bg-neutral-400",
  tools: "bg-blue-400",
  skills: "bg-amber-400",
  memory: "bg-emerald-400",
  user: "bg-purple-400",
  assistant: "bg-cyan-400",
  toolCalls: "bg-rose-400",
  toolOutput: "bg-pink-400",
  compaction: "bg-purple-600",
  other: "bg-neutral-600",
};

function clampPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

export function formatContextTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return Math.round(value).toLocaleString();
}

export function presentContextUsage(usage: ContextUsage): ContextUsageView {
  const percent = clampPercent(usage.percent);
  const remaining = usage.tokens === null
    ? null
    : Math.max(0, usage.contextWindow - usage.tokens);
  return {
    percent,
    percentLabel: percent === null ? "Refreshing" : `${Math.round(percent)}%`,
    usedLabel: formatContextTokens(usage.tokens),
    remainingLabel: formatContextTokens(remaining),
    windowLabel: formatContextTokens(usage.contextWindow),
    filledCells: percent === null ? 0 : Math.min(MAP_CELLS, Math.round((percent / 100) * MAP_CELLS)),
    tone: percent !== null && percent >= 90 ? "danger" : percent !== null && percent >= 75 ? "warning" : "default",
  };
}

export function allocateContextCells(
  categories: ContextManifestV1["categories"],
  filledCells: number,
): OcodeContextCategoryId[] {
  const count = Math.max(0, Math.min(MAP_CELLS, Math.round(filledCells)));
  if (count === 0) return [];
  const total = categories.reduce((sum, category) => sum + category.tokens, 0);
  if (total <= 0) return Array.from({ length: count }, () => "other" as const);

  const allocations = OCODE_CONTEXT_CATEGORY_IDS.map((id, index) => {
    const tokens = categories.find((category) => category.id === id)?.tokens ?? 0;
    const exact = (tokens / total) * count;
    return { id, index, cells: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = count - allocations.reduce((sum, category) => sum + category.cells, 0);
  for (const category of [...allocations].sort((left, right) => right.remainder - left.remainder || left.index - right.index)) {
    if (remaining-- <= 0) break;
    category.cells++;
  }
  return allocations.flatMap((category) => Array.from({ length: category.cells }, () => category.id));
}

function toneClasses(tone: ContextUsageView["tone"]): string {
  if (tone === "danger") return "text-destructive";
  if (tone === "warning") return "text-[var(--status-warning)]";
  return "text-foreground";
}

export interface ContextCellTooltipView {
  label: string;
  detail: string;
  colorClass: string;
}

function formatContextShare(tokens: number, contextWindow: number): string {
  if (tokens <= 0 || contextWindow <= 0) return "0%";
  const percent = (tokens / contextWindow) * 100;
  return percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

export function presentContextCellTooltip(
  category: OcodeContextCategoryId,
  usage: ContextUsage,
  categories: ContextManifestV1["categories"],
): ContextCellTooltipView {
  const tokens = categories.find((candidate) => candidate.id === category)?.tokens ?? 0;
  return {
    label: OCODE_CONTEXT_CATEGORY_LABELS[category],
    detail: `${formatContextTokens(tokens)} tokens · ${formatContextShare(tokens, usage.contextWindow)} of context`,
    colorClass: CATEGORY_COLOR_CLASSES[category],
  };
}

const ContextMapCell = memo(function ContextMapCell({
  index,
  used,
  category,
  tone,
  tooltip,
  onDismiss,
}: {
  index: number;
  used: boolean;
  category?: OcodeContextCategoryId;
  tone: ContextUsageView["tone"];
  tooltip?: ContextCellTooltipView;
  onDismiss: () => void;
}) {
  const cell = (
    <span
      aria-hidden="true"
      data-context-cell-index={index}
      data-context-category={category}
      data-context-interactive={used || undefined}
      className={cn(
        "context-lens-cell",
        !used && "bg-muted",
        used && "cursor-help",
        used && !category && "context-lens-cell--used",
        used && !category && tone === "warning" && "context-lens-cell--warning",
        used && !category && tone === "danger" && "context-lens-cell--danger",
        category && CATEGORY_COLOR_CLASSES[category],
      )}
    />
  );
  if (!tooltip) return cell;
  return (
    <Tooltip open onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <TooltipTrigger asChild>{cell}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        <span className={cn("size-2 rounded-[2px]", tooltip.colorClass)} aria-hidden="true" />
        <span className="font-medium">{tooltip.label}</span>
        <span className="text-background/70">{tooltip.detail}</span>
      </TooltipContent>
    </Tooltip>
  );
});

function ContextLensSkeleton({ embedded = false }: { embedded?: boolean }) {
  return (
    <aside className={embedded ? "context-lens-embedded" : "context-lens"} aria-label="Loading context usage" aria-busy="true">
      <Card size="sm" className="context-lens-card gap-0 py-0">
        <CardContent className="py-3">
          <div className="mb-2 flex items-end justify-between gap-3">
            <Skeleton className="h-6 w-14" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-1 w-full" />
        </CardContent>

        <Separator />

        <CardContent className="py-3">
          <div className="context-lens-map" role="img" aria-label="Context map is loading">
            {Array.from({ length: MAP_CELLS }, (_, index) => (
              <Skeleton className="context-lens-cell" key={index} aria-hidden="true" />
            ))}
          </div>
        </CardContent>
      </Card>
    </aside>
  );
}

function selectContextUsage(usage: ContextUsage | undefined, manifest: ContextManifestV1 | undefined): ContextUsage | undefined {
  const manifestUsage = manifest?.usage;
  if (!manifestUsage) return usage;
  if (manifestUsage.tokens === null) return manifestUsage;
  if (!usage || usage.tokens === null || usage.contextWindow !== manifestUsage.contextWindow) return manifestUsage;
  // Context grows monotonically between compactions. Prefer whichever known
  // source has observed more of that growth; compaction emits the null state above.
  return usage.tokens >= manifestUsage.tokens ? usage : manifestUsage;
}

export function ContextLens({ usage, manifest, loading = true, embedded = false }: {
  usage?: ContextUsage;
  manifest?: ContextManifestV1;
  loading?: boolean;
  embedded?: boolean;
}) {
  const [activeCellIndex, setActiveCellIndex] = useState<number>();
  const [revealed, setRevealed] = useState(false);
  const dismissTooltip = useCallback(() => setActiveCellIndex(undefined), []);
  const effectiveUsage = selectContextUsage(usage, manifest);
  const hasContext = effectiveUsage?.tokens !== null && effectiveUsage?.tokens !== undefined && effectiveUsage.tokens > 0;

  useEffect(() => {
    if (!hasContext) {
      setRevealed(false);
      return;
    }
    const frame = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(frame);
  }, [hasContext]);

  if (!effectiveUsage) return loading ? <ContextLensSkeleton embedded={embedded} /> : null;
  if (effectiveUsage.tokens === 0) return null;
  if (effectiveUsage.tokens === null || effectiveUsage.percent === null) return <ContextLensSkeleton embedded={embedded} />;

  const view = presentContextUsage(effectiveUsage);
  const displayCategories = manifest
    ? reconcileContextCategories(
      Object.fromEntries(manifest.categories.map((category) => [category.id, category.tokens])),
      effectiveUsage.tokens,
    )
    : [];
  const categoryCells = manifest ? allocateContextCells(displayCategories, view.filledCells) : [];
  const categorySummary = displayCategories
    .filter((category) => category.tokens > 0)
    .map((category) => `${OCODE_CONTEXT_CATEGORY_LABELS[category.id]} ${formatContextTokens(category.tokens)}`)
    .join(", ");
  const accessibleLabel = `Context usage: ${view.percentLabel}, ${view.usedLabel} of ${view.windowLabel} tokens`;
  const mapLabel = `${view.filledCells} of ${MAP_CELLS} context blocks used${categorySummary ? `. ${categorySummary}` : ""}`;

  return (
    <aside
      className={embedded ? "context-lens-embedded" : "context-lens t-panel-slide"}
      data-open={embedded || revealed}
      aria-label={accessibleLabel}
    >
      <Card size="sm" className="context-lens-card gap-0 py-0">
        <CardContent className="py-3">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <strong className={cn("font-heading text-xl font-medium tracking-tight", toneClasses(view.tone))}>{view.percentLabel}</strong>
            <span className="text-[0.625rem] text-muted-foreground">{view.usedLabel}/{view.windowLabel}</span>
          </div>
          <Progress
            value={view.percent ?? 0}
            aria-label={accessibleLabel}
            className={cn(
              view.tone === "warning" && "context-lens-progress--warning",
              view.tone === "danger" && "context-lens-progress--danger",
            )}
          />
        </CardContent>

        {manifest && (
          <>
            <Separator />

            <CardContent className="py-3">
              <div
                className="context-lens-map"
                role="img"
                aria-label={mapLabel}
                onPointerMove={(event) => {
                  const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-context-interactive]");
                  const index = cell ? Number(cell.dataset.contextCellIndex) : undefined;
                  setActiveCellIndex((current) => current === index ? current : index);
                }}
                onPointerLeave={dismissTooltip}
              >
                {Array.from({ length: MAP_CELLS }, (_, index) => {
                  const category = categoryCells[index];
                  const used = index < view.filledCells;
                  return (
                    <ContextMapCell
                      key={index}
                      index={index}
                      used={used}
                      category={category}
                      tone={view.tone}
                      tooltip={used && category && activeCellIndex === index
                        ? presentContextCellTooltip(category, effectiveUsage, displayCategories)
                        : undefined}
                      onDismiss={dismissTooltip}
                    />
                  );
                })}
              </div>
            </CardContent>
          </>
        )}
      </Card>
    </aside>
  );
}
