import type { UsageSummary } from "@anvil/protocol";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

const RANGES = [7, 30, 90] as const;
type UsageRange = typeof RANGES[number];

const compactNumber = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const currency = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function displayDay(day: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
}

function StatCard({ label, value, description }: { label: string; value: string; description: string }) {
  return (
    <Card className="gap-2">
      <CardHeader className="gap-0.5">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-[0.6875rem] text-muted-foreground">{description}</CardContent>
    </Card>
  );
}

function LoadingCards() {
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
    {Array.from({ length: 4 }, (_, index) => <Card key={index} className="gap-3"><Skeleton className="h-3 w-20" /><Skeleton className="h-6 w-24" /><Skeleton className="h-3 w-28" /></Card>)}
  </div>;
}

export function UsageDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [range, setRange] = useState<UsageRange>(30);
  const [summary, setSummary] = useState<UsageSummary>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    void fetch(`/api/v1/usage?days=${range}&timeZone=${encodeURIComponent(timeZone)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Forge could not read Pi usage.");
        return response.json() as Promise<UsageSummary>;
      })
      .then(setSummary)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Usage is unavailable.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, range, refreshKey]);

  const processedInput = summary
    ? summary.tokens.input + summary.tokens.cacheRead + summary.tokens.cacheWrite
    : 0;
  const cacheRate = summary && processedInput > 0 ? summary.tokens.cacheRead / processedInput : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(42rem,calc(100dvh-2rem))] overflow-y-auto sm:max-w-3xl">
        <DialogHeader className="pr-8">
          <DialogTitle>Usage</DialogTitle>
          <DialogDescription>
            API-equivalent cost and tokens recorded in your local Pi transcripts.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center rounded-md border p-0.5">
            {RANGES.map((days) => (
              <Button
                key={days}
                type="button"
                variant={range === days ? "secondary" : "ghost"}
                size="sm"
                className="h-6 px-2"
                aria-pressed={range === days}
                onClick={() => setRange(days)}
              >
                {days} days
              </Button>
            ))}
          </div>
          <Button type="button" variant="outline" size="icon-sm" aria-label="Refresh usage" onClick={refresh} disabled={loading}>
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} className={loading ? "animate-spin" : undefined} />
          </Button>
        </div>

        {loading && !summary ? <LoadingCards /> : error && !summary ? (
          <Card>
            <CardHeader><CardTitle>Usage unavailable</CardTitle><CardDescription>{error}</CardDescription></CardHeader>
            <CardContent><Button variant="outline" size="sm" onClick={refresh}>Try again</Button></CardContent>
          </Card>
        ) : summary ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatCard label="Estimated cost" value={currency.format(summary.cost.total)} description="Not your subscription bill" />
              <StatCard label="Tokens" value={compactNumber.format(summary.tokens.total)} description={`${summary.responses.toLocaleString()} responses`} />
              <StatCard label="Cached input" value={`${(cacheRate * 100).toFixed(1)}%`} description={compactNumber.format(summary.tokens.cacheRead)} />
              <StatCard label="Output" value={compactNumber.format(summary.tokens.output)} description={`${compactNumber.format(summary.tokens.reasoning)} reasoning`} />
            </div>

            <Card className="gap-2">
              <CardHeader>
                <CardTitle>Models</CardTitle>
                <CardDescription>{displayDay(summary.sinceDay)} – {displayDay(summary.untilDay)}</CardDescription>
              </CardHeader>
              <CardContent>
                {summary.models.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">No usage in this period.</p>
                ) : (
                  <div className="divide-y">
                    {summary.models.map((model) => (
                      <div key={`${model.provider}/${model.model}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 py-2.5 text-xs first:pt-0 last:pb-0">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{model.model}</div>
                          <div className="truncate text-[0.6875rem] text-muted-foreground">{model.provider} · {model.responses.toLocaleString()} responses</div>
                        </div>
                        <span className="text-muted-foreground tabular-nums">{compactNumber.format(model.tokens)}</span>
                        <span className="w-16 text-right font-medium tabular-nums">{currency.format(model.cost)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        ) : null}

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-[0.6875rem] text-muted-foreground">
            {summary ? `${summary.transcripts} transcripts · ${summary.duplicates} copied responses excluded` : "Read from ~/.pi/agent/sessions"}
          </span>
          <DialogClose asChild><Button variant="outline">Done</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
