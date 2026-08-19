import type { PiCatalog, PiCatalogItem, PiCatalogItemKind } from "@anvil/protocol";
import { BookOpen01Icon, PuzzleIcon, RefreshIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

function displayModifiedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function CatalogRow({ item }: { item: PiCatalogItem }) {
  const icon = item.kind === "skill" ? BookOpen01Icon : PuzzleIcon;
  return (
    <div className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 border-b px-3 py-3 last:border-b-0">
      <div className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <HugeiconsIcon icon={icon} strokeWidth={1.8} className="size-4" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-xs font-medium">{item.name}</div>
        <div className="truncate text-[0.6875rem] text-muted-foreground">{item.description ?? item.path}</div>
      </div>
      <div className="hidden text-right sm:block">
        <Badge variant="outline">User</Badge>
        <div className="mt-1 text-[0.625rem] text-muted-foreground">{displayModifiedAt(item.modifiedAt)}</div>
      </div>
    </div>
  );
}

export function PiCatalogPage() {
  const [kind, setKind] = useState<PiCatalogItemKind>("skill");
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<PiCatalog>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void fetch("/api/v1/pi/catalog", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Forge could not read the Pi catalog.");
        return response.json() as Promise<PiCatalog>;
      })
      .then(setCatalog)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "The Pi catalog is unavailable.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refreshKey]);

  const items = kind === "skill" ? catalog?.skills ?? [] : catalog?.extensions ?? [];
  const root = kind === "skill" ? catalog?.skillsRoot : catalog?.extensionsRoot;
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter((item) => `${item.name} ${item.description ?? ""} ${item.path}`.toLocaleLowerCase().includes(needle));
  }, [items, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="session-header" data-tauri-drag-region="deep">
        <div className="header-title-group">
          <SidebarTrigger className="menu-trigger" aria-label="Toggle sidebar" />
          <div className="session-heading"><h1>Skills &amp; extensions</h1></div>
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-8 sm:py-10">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="grid gap-1">
              <h1 className="text-xl font-semibold tracking-tight">Your Pi setup</h1>
              <p className="max-w-2xl text-sm text-muted-foreground">Browse the global skills and extensions available to Pi on this Forge. This view is read-only.</p>
            </div>
            <Button type="button" variant="outline" size="icon-sm" aria-label="Refresh skills and extensions" onClick={refresh} disabled={loading}>
              <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} className={loading ? "animate-spin" : undefined} />
            </Button>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={kind} onValueChange={(value) => value && setKind(value as PiCatalogItemKind)}>
              <ToggleGroupItem value="skill">Skills&nbsp; {catalog?.skills.length ?? 0}</ToggleGroupItem>
              <ToggleGroupItem value="extension">Extensions&nbsp; {catalog?.extensions.length ?? 0}</ToggleGroupItem>
            </ToggleGroup>
            <div className="relative w-full sm:w-64">
              <HugeiconsIcon icon={Search01Icon} strokeWidth={2} className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${kind}s`} className="pl-7" aria-label={`Search ${kind}s`} />
            </div>
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xs font-medium">Installed {kind}s</h2>
              {root && <code className="truncate rounded border bg-muted/50 px-1.5 py-0.5 text-[0.625rem] text-muted-foreground">{root}</code>}
            </div>
            <Card className="gap-0 py-0">
              <CardContent className="px-0">
                {loading ? (
                  <div className="flex min-h-40 items-center justify-center" aria-label="Loading skills and extensions"><Spinner className="size-5 text-muted-foreground" /></div>
                ) : error ? (
                  <div className="grid min-h-40 place-content-center gap-3 px-5 text-center"><p className="text-xs text-destructive">{error}</p><Button variant="outline" size="sm" onClick={refresh}>Try again</Button></div>
                ) : filtered.length > 0 ? (
                  filtered.map((item) => <CatalogRow key={`${item.kind}:${item.path}`} item={item} />)
                ) : (
                  <div className="grid min-h-40 place-content-center px-5 text-center"><p className="text-xs font-medium">No {kind}s found</p><p className="mt-1 text-[0.6875rem] text-muted-foreground">{query ? "Try a different search." : `Add one under ${root ?? "your Pi agent directory"}.`}</p></div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
