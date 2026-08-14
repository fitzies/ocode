import type { UsageSummary } from "@anvil/protocol";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

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

function UsageLoading() {
  return (
    <div className="flex min-h-40 items-center justify-center" aria-label="Loading usage">
      <Spinner className="size-5 text-muted-foreground" />
    </div>
  );
}

export function UsagePage() {
  const [range, setRange] = useState<UsageRange>(30);
  const [summary, setSummary] = useState<UsageSummary>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
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
  }, [range, refreshKey]);

  const processedInput = summary
    ? summary.tokens.input + summary.tokens.cacheRead + summary.tokens.cacheWrite
    : 0;
  const cacheRate = summary && processedInput > 0 ? summary.tokens.cacheRead / processedInput : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="session-header" data-tauri-drag-region="deep">
        <div className="header-title-group">
          <SidebarTrigger className="menu-trigger" aria-label="Toggle sidebar" />
          <div className="session-heading"><h1>Usage</h1></div>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-7 px-4 py-8 sm:px-8 sm:py-10">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="grid gap-1">
              <h1 className="text-xl font-semibold tracking-tight">Usage</h1>
              <p className="text-sm text-muted-foreground">API-equivalent cost and tokens recorded in your local Pi transcripts.</p>
            </div>
            <div className="flex items-center gap-2">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={0}
                value={String(range)}
                onValueChange={(value) => value && setRange(Number(value) as UsageRange)}
                aria-label="Usage period"
              >
                {RANGES.map((days) => <ToggleGroupItem key={days} value={String(days)}>{days} days</ToggleGroupItem>)}
              </ToggleGroup>
              <Button type="button" variant="outline" size="icon-sm" aria-label="Refresh usage" onClick={refresh} disabled={loading}>
                <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} className={loading ? "animate-spin" : undefined} />
              </Button>
            </div>
          </div>

          {loading && !summary ? <UsageLoading /> : error && !summary ? (
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
                    <p className="py-6 text-center text-xs text-muted-foreground">No usage in this period.</p>
                  ) : (
                    <div className="divide-y">
                      {summary.models.map((model) => (
                        <div key={`${model.provider}/${model.model}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 py-3 text-xs first:pt-0 last:pb-0">
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

          <div className="border-t pt-4 text-[0.6875rem] text-muted-foreground">
            {summary ? `${summary.transcripts} transcripts · ${summary.duplicates} copied responses excluded` : "Read from ~/.pi/agent/sessions"}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
