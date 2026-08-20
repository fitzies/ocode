import type { PiCatalog, PiCatalogItem, PiCatalogItemKind, PiResourceContent } from "@anvil/protocol";
import {
  Add01Icon,
  AlertCircleIcon,
  ArrowLeft02Icon,
  ArrowRight01Icon,
  BookOpen01Icon,
  Copy01Icon,
  Delete02Icon,
  Edit02Icon,
  FileCodeIcon,
  MoreHorizontalIcon,
  PuzzleIcon,
  RefreshIcon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useBlocker, useNavigate, useRouterState } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { SourceViewer } from "@/components/resource/SourceViewer";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const AUTOSAVE_DELAY_MS = 800;
const NAME_PATTERN = "(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error" | "conflict";
type NameDialogState = {
  mode: "create" | "rename" | "duplicate";
  target?: PiResourceContent;
};

class CatalogRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = await response.json().catch(() => undefined) as { code?: string; message?: string } | T | undefined;
  if (!response.ok) {
    const error = value && typeof value === "object" && "message" in value ? value : undefined;
    throw new CatalogRequestError(error?.message ?? "Forge could not complete the request.", error?.code, response.status);
  }
  return value as T;
}

function mutation<T>(url: string, method: string, value: Record<string, unknown>): Promise<T> {
  return jsonRequest<T>(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

export function piCatalogLocation(pathname: string): { kind: PiCatalogItemKind; resourceId?: string } {
  const kind: PiCatalogItemKind = pathname.startsWith("/pi/extensions") ? "extension" : "skill";
  const prefix = kind === "skill" ? "/pi/skills/" : "/pi/extensions/";
  if (!pathname.startsWith(prefix)) return { kind };
  const encoded = pathname.slice(prefix.length);
  if (!encoded) return { kind };
  try {
    return { kind, resourceId: decodeURIComponent(encoded) };
  } catch {
    return { kind };
  }
}

export function piCatalogResourcePath(kind: PiCatalogItemKind, id?: string): string {
  const root = kind === "skill" ? "/pi/skills" : "/pi/extensions";
  if (!id) return root;
  return `${root}/${encodeURIComponent(id)}`;
}

export function filterPiCatalogItems(items: readonly PiCatalogItem[], query: string): PiCatalogItem[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...items];
  return items.filter((item) => `${item.name} ${item.description ?? ""} ${item.path}`.toLocaleLowerCase().includes(needle));
}

function displayModifiedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function itemIcon(kind: PiCatalogItemKind) {
  return kind === "skill" ? BookOpen01Icon : PuzzleIcon;
}

function NameDialog({ state, onClose, onSubmit }: {
  state: NameDialogState;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const initialName = state.mode === "rename"
    ? state.target?.item.name ?? ""
    : state.mode === "duplicate"
      ? `${state.target?.item.name ?? "skill"}-copy`
      : "";
  const [name, setName] = useState(initialName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const title = state.mode === "create" ? "Create skill" : state.mode === "rename" ? "Rename skill" : "Duplicate skill";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await onSubmit(name);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {state.mode === "create"
              ? "ocode will create a minimal SKILL.md and open it for editing."
              : "Use lowercase letters, numbers, and single hyphens."}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <Field>
            <FieldLabel htmlFor="pi-skill-name">Name</FieldLabel>
            <Input
              id="pi-skill-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              pattern={NAME_PATTERN}
              autoComplete="off"
              required
              disabled={pending}
              autoFocus
            />
          </Field>
          {error && <FieldError role="alert">{error}</FieldError>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? "Working…" : title}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CatalogLoading() {
  return (
    <div className="overflow-hidden rounded-lg border" aria-label="Loading skills and extensions">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
          <Skeleton className="size-8 shrink-0" />
          <div className="grid flex-1 gap-2"><Skeleton className="h-3 w-36" /><Skeleton className="h-2.5 w-3/5" /></div>
          <Skeleton className="hidden h-3 w-20 sm:block" />
        </div>
      ))}
    </div>
  );
}

function SaveStatus({ state, error, onRetry, onReload }: {
  state: SaveState;
  error?: string;
  onRetry: () => void;
  onReload: () => void;
}) {
  if (state === "error" || state === "conflict") {
    return (
      <div className="flex min-w-0 items-center gap-2" role="alert">
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-destructive">
          <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} className="size-3.5 shrink-0" />
          <span className="hidden truncate sm:inline">{error ?? "Save failed"}</span>
          <span className="sm:hidden">Save failed</span>
        </span>
        {state === "conflict"
          ? <Button variant="outline" size="xs" onClick={onReload}>Reload</Button>
          : <Button variant="outline" size="xs" onClick={onRetry}>Retry</Button>}
      </div>
    );
  }

  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status" aria-live="polite">
      {state === "saving"
        ? <Spinner className="size-3" />
        : state === "saved"
          ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-3.5 text-[var(--status-success)]" />
          : null}
      {state === "saving" ? "Saving" : state === "dirty" ? "Waiting to save" : "Saved"}
    </span>
  );
}

export function PiCatalogPage() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const { kind, resourceId } = piCatalogLocation(pathname);
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<PiCatalog>();
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string>();
  const [resource, setResource] = useState<PiResourceContent>();
  const [resourceLoading, setResourceLoading] = useState(false);
  const [resourceError, setResourceError] = useState<string>();
  const [draft, setDraft] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string>();
  const [nameDialog, setNameDialog] = useState<NameDialogState>();
  const [deleteTarget, setDeleteTarget] = useState<PiResourceContent>();
  const [deletePending, setDeletePending] = useState(false);
  const resourceRef = useRef<PiResourceContent | undefined>(undefined);
  const draftRef = useRef("");
  const savePromiseRef = useRef<Promise<boolean> | undefined>(undefined);
  const saveNowRef = useRef<() => Promise<boolean>>(async () => true);
  const resourceLoadGenerationRef = useRef(0);

  const goToLibrary = useCallback((nextKind: PiCatalogItemKind) => {
    if (nextKind === "skill") void navigate({ to: "/pi/skills" });
    else void navigate({ to: "/pi/extensions" });
  }, [navigate]);

  const goToResource = useCallback((nextKind: PiCatalogItemKind, id: string, replace = false) => {
    if (nextKind === "skill") void navigate({ to: "/pi/skills/$resourceId", params: { resourceId: id }, replace });
    else void navigate({ to: "/pi/extensions/$resourceId", params: { resourceId: id }, replace });
  }, [navigate]);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(undefined);
    try {
      setCatalog(await jsonRequest<PiCatalog>("/api/v1/pi/catalog"));
    } catch (failure) {
      setCatalogError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const loadResource = useCallback(async (nextKind: PiCatalogItemKind, id: string) => {
    const generation = ++resourceLoadGenerationRef.current;
    setResourceLoading(true);
    setResourceError(undefined);
    if (resourceRef.current?.item.id !== id || resourceRef.current.item.kind !== nextKind) {
      resourceRef.current = undefined;
      setResource(undefined);
    }
    try {
      const next = await jsonRequest<PiResourceContent>(`/api/v1/pi/resources/content?kind=${nextKind}&id=${encodeURIComponent(id)}`);
      if (resourceLoadGenerationRef.current !== generation) return undefined;
      resourceRef.current = next;
      draftRef.current = next.text;
      setResource(next);
      setDraft(next.text);
      setSaveState("idle");
      setSaveError(undefined);
      return next;
    } catch (failure) {
      if (resourceLoadGenerationRef.current !== generation) return undefined;
      setResource(undefined);
      resourceRef.current = undefined;
      setResourceError(failure instanceof Error ? failure.message : String(failure));
      return undefined;
    } finally {
      if (resourceLoadGenerationRef.current === generation) setResourceLoading(false);
    }
  }, []);

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  useEffect(() => {
    if (!resourceId) {
      resourceLoadGenerationRef.current += 1;
      setResource(undefined);
      setResourceError(undefined);
      resourceRef.current = undefined;
      draftRef.current = "";
      setDraft("");
      setSaveState("idle");
      return;
    }
    void loadResource(kind, resourceId);
  }, [kind, loadResource, resourceId]);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (kind !== "skill") return true;
    if (saveState === "conflict") return false;
    if (savePromiseRef.current) {
      const saved = await savePromiseRef.current;
      if (!saved) return false;
      return resourceRef.current && draftRef.current !== resourceRef.current.text
        ? saveNowRef.current()
        : true;
    }

    const current = resourceRef.current;
    const text = draftRef.current;
    if (!current || text === current.text) return true;

    const operation = (async () => {
      setSaveState("saving");
      setSaveError(undefined);
      try {
        const next = await mutation<PiResourceContent>("/api/v1/pi/skills/content", "PUT", {
          id: current.item.id,
          text,
          etag: current.etag,
        });
        if (resourceRef.current?.item.id !== current.item.id) return true;
        resourceRef.current = next;
        setResource(next);
        setSaveState(draftRef.current === text ? "saved" : "dirty");
        return true;
      } catch (failure) {
        const conflict = failure instanceof CatalogRequestError && failure.code === "resource_changed";
        const message = failure instanceof Error ? failure.message : String(failure);
        setSaveState(conflict ? "conflict" : "error");
        setSaveError(message);
        toast.error(conflict ? "Skill changed outside ocode" : "Could not save skill", { description: message });
        return false;
      }
    })();

    savePromiseRef.current = operation;
    try {
      return await operation;
    } finally {
      if (savePromiseRef.current === operation) savePromiseRef.current = undefined;
    }
  }, [kind, saveState]);
  saveNowRef.current = saveNow;

  useEffect(() => {
    if (kind !== "skill" || !resource || draft === resource.text || saveState === "error" || saveState === "conflict" || saveState === "saving") return;
    const timer = window.setTimeout(() => { void saveNow(); }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft, kind, resource, saveNow, saveState]);

  const shouldBlockNavigation = useCallback(async () => {
    const current = resourceRef.current;
    if (kind !== "skill" || !current || draftRef.current === current.text) return false;
    const saved = await saveNowRef.current();
    if (!saved) toast.error("Resolve the save error before leaving this skill.");
    return !saved;
  }, [kind]);

  useBlocker({
    shouldBlockFn: shouldBlockNavigation,
    enableBeforeUnload: () => {
      const current = resourceRef.current;
      return kind === "skill" && Boolean(current && draftRef.current !== current.text);
    },
    disabled: kind !== "skill" || !resourceId,
  });

  const items = kind === "skill" ? catalog?.skills ?? [] : catalog?.extensions ?? [];
  const filtered = useMemo(() => filterPiCatalogItems(items, query), [items, query]);
  const root = kind === "skill" ? catalog?.skillsRoot : catalog?.extensionsRoot;

  const fetchActionTarget = useCallback(async (item: PiCatalogItem): Promise<PiResourceContent | undefined> => {
    const current = resourceRef.current;
    if (current?.item.id === item.id && current.item.kind === item.kind) return current;
    try {
      return await jsonRequest<PiResourceContent>(`/api/v1/pi/resources/content?kind=${item.kind}&id=${encodeURIComponent(item.id)}`);
    } catch (failure) {
      toast.error("Could not open skill actions", { description: failure instanceof Error ? failure.message : String(failure) });
      return undefined;
    }
  }, []);

  const openSkillAction = useCallback(async (mode: "rename" | "duplicate" | "delete", item: PiCatalogItem) => {
    const target = await fetchActionTarget(item);
    if (!target) return;
    if (mode === "delete") setDeleteTarget(target);
    else setNameDialog({ mode, target });
  }, [fetchActionTarget]);

  const submitNameDialog = async (name: string) => {
    if (!nameDialog) return;
    if (nameDialog.mode === "create") {
      const next = await mutation<PiResourceContent>("/api/v1/pi/skills", "POST", { name });
      await loadCatalog();
      toast.success(`${next.item.name} created`, { description: "Start writing. Changes save automatically." });
      goToResource("skill", next.item.id);
      return;
    }
    const target = nameDialog.target;
    if (!target) return;
    if (nameDialog.mode === "duplicate") {
      const next = await mutation<PiResourceContent>("/api/v1/pi/skills/duplicate", "POST", {
        id: target.item.id,
        name,
      });
      await loadCatalog();
      toast.success(`${next.item.name} created`);
      goToResource("skill", next.item.id);
      return;
    }
    if (resourceRef.current?.item.id === target.item.id && !(await saveNow())) {
      throw new Error("Save the current skill before renaming it.");
    }
    const latest = resourceRef.current?.item.id === target.item.id ? resourceRef.current : target;
    if (!latest) return;
    const next = await mutation<PiResourceContent>("/api/v1/pi/skills", "PATCH", {
      id: latest.item.id,
      name,
      etag: latest.etag,
    });
    resourceRef.current = next;
    draftRef.current = next.text;
    setResource(next);
    setDraft(next.text);
    await loadCatalog();
    toast.success(`${next.item.name} renamed`);
    goToResource("skill", next.item.id, true);
  };

  const removeSkill = async () => {
    if (!deleteTarget || deletePending) return;
    setDeletePending(true);
    try {
      if (resourceRef.current?.item.id === deleteTarget.item.id && !(await saveNow())) return;
      const latest = resourceRef.current?.item.id === deleteTarget.item.id ? resourceRef.current : deleteTarget;
      if (!latest) return;
      await mutation<{ deleted: true }>("/api/v1/pi/skills", "DELETE", {
        id: latest.item.id,
        etag: latest.etag,
      });
      setDeleteTarget(undefined);
      resourceRef.current = undefined;
      draftRef.current = "";
      setResource(undefined);
      setDraft("");
      await loadCatalog();
      toast.success(`${latest.item.name} deleted`);
      if (resourceId === latest.item.id) goToLibrary("skill");
    } catch (failure) {
      toast.error("Could not delete skill", { description: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      setDeletePending(false);
    }
  };

  const reloadResource = () => {
    if (resourceId) void loadResource(kind, resourceId);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="session-header" data-tauri-drag-region="deep">
        <div className="header-title-group">
          <SidebarTrigger className="menu-trigger" aria-label="Toggle sidebar" />
          <div className="session-heading"><h1>Skills &amp; extensions</h1></div>
        </div>
      </header>

      {resourceId ? (
        <main className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-14 flex-wrap items-center gap-3 border-b px-3 py-2 sm:flex-nowrap sm:px-5">
            <Button variant="ghost" size="icon-sm" aria-label={`Back to ${kind}s`} onClick={() => goToLibrary(kind)}>
              <HugeiconsIcon icon={ArrowLeft02Icon} strokeWidth={2} />
            </Button>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <HugeiconsIcon icon={itemIcon(kind)} strokeWidth={1.8} className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-sm font-semibold tracking-tight">{resource?.item.name ?? (resourceLoading ? "Opening…" : "Resource")}</h2>
                <Badge variant="outline" className="hidden sm:inline-flex">{kind === "skill" ? "Editable" : "Read-only"}</Badge>
              </div>
              <p className="truncate text-[0.6875rem] text-muted-foreground">{resource?.item.path ?? resourceId}</p>
            </div>
            {kind === "skill" && resource && (
              <>
                <SaveStatus state={saveState} error={saveError} onRetry={() => void saveNow()} onReload={reloadResource} />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="Skill actions">
                      <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => void openSkillAction("rename", resource.item)}>
                      <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void openSkillAction("duplicate", resource.item)}>
                      <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => void openSkillAction("delete", resource.item)}>
                      <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>

          {resourceLoading ? (
            <div className="grid flex-1 place-content-center" role="status"><Spinner className="size-5" /><span className="sr-only">Opening resource</span></div>
          ) : resourceError ? (
            <Empty className="m-auto max-w-md border-0">
              <EmptyHeader><EmptyMedia variant="icon"><HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} /></EmptyMedia><EmptyTitle>Could not open resource</EmptyTitle><EmptyDescription>{resourceError}</EmptyDescription></EmptyHeader>
              <EmptyContent><Button variant="outline" onClick={reloadResource}>Try again</Button></EmptyContent>
            </Empty>
          ) : resource ? (
            kind === "skill" ? (
              <div className="min-h-0 flex-1 p-3 sm:p-5">
                <Textarea
                  value={draft}
                  onChange={(event) => {
                    const value = event.target.value;
                    draftRef.current = value;
                    setDraft(value);
                    setSaveState((current) => {
                      if (current === "conflict") return current;
                      return value === resourceRef.current?.text ? "saved" : "dirty";
                    });
                    if (saveState !== "conflict") setSaveError(undefined);
                  }}
                  aria-label={`Edit ${resource.item.name}`}
                  spellCheck={false}
                  className="h-full min-h-72 resize-none bg-card p-4 font-mono text-[0.8125rem] leading-6 shadow-xs sm:p-5"
                />
              </div>
            ) : (
              <div className="min-h-0 flex-1 p-3 sm:p-5">
                <div className="h-full min-h-72 overflow-hidden rounded-lg border bg-card shadow-xs">
                  <SourceViewer path={resource.item.path} text={resource.text} />
                </div>
              </div>
            )
          ) : null}
        </main>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-7 sm:px-8 sm:py-10">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="grid max-w-2xl gap-1.5">
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-semibold tracking-tight">{kind === "skill" ? "Skills" : "Extensions"}</h1>
                  <Badge variant="outline">{items.length}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {kind === "skill"
                    ? "Write the reusable instructions Pi can apply across your work. Skill edits save automatically and apply to new sessions."
                    : "Browse the extension entry points available to Pi on this Forge. Extension source is read-only in ocode."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {kind === "skill" && (
                  <Button onClick={() => setNameDialog({ mode: "create" })}>
                    <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />New skill
                  </Button>
                )}
                <Button variant="outline" size="icon" aria-label="Refresh library" onClick={() => void loadCatalog()} disabled={catalogLoading}>
                  <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} className={catalogLoading ? "animate-spin" : undefined} />
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={0}
                value={kind}
                onValueChange={(value) => value && goToLibrary(value as PiCatalogItemKind)}
                aria-label="Resource type"
              >
                <ToggleGroupItem value="skill">Skills</ToggleGroupItem>
                <ToggleGroupItem value="extension">Extensions</ToggleGroupItem>
              </ToggleGroup>
              <InputGroup className="w-full sm:w-72">
                <InputGroupAddon><HugeiconsIcon icon={Search01Icon} strokeWidth={2} /></InputGroupAddon>
                <InputGroupInput
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={`Search ${kind}s`}
                  aria-label={`Search ${kind}s`}
                />
              </InputGroup>
            </div>

            <section className="grid gap-2" aria-labelledby="pi-catalog-list-title">
              <div className="flex min-w-0 items-center justify-between gap-4 px-1">
                <div>
                  <h2 id="pi-catalog-list-title" className="text-xs font-medium">{query ? `${filtered.length} matching ${kind}${filtered.length === 1 ? "" : "s"}` : `All ${kind}s`}</h2>
                  <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">{kind === "skill" ? "Right-click a skill for more actions." : "Open an extension to inspect its source."}</p>
                </div>
                {root && <code className="hidden max-w-64 truncate rounded-md bg-muted px-2 py-1 text-[0.625rem] text-muted-foreground sm:block">{root}</code>}
              </div>

              {catalogLoading && !catalog ? <CatalogLoading /> : catalogError && !catalog ? (
                <Empty className="min-h-64 border">
                  <EmptyHeader><EmptyMedia variant="icon"><HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} /></EmptyMedia><EmptyTitle>Library unavailable</EmptyTitle><EmptyDescription>{catalogError}</EmptyDescription></EmptyHeader>
                  <EmptyContent><Button variant="outline" onClick={() => void loadCatalog()}>Try again</Button></EmptyContent>
                </Empty>
              ) : filtered.length ? (
                <ItemGroup className="gap-0 overflow-hidden rounded-lg border bg-card shadow-xs">
                  {filtered.map((item) => {
                    const row = (
                      <Item asChild className="rounded-none border-0 border-b px-4 py-3 last:border-b-0 hover:bg-muted/50">
                        <button type="button" className="text-left" onClick={() => goToResource(item.kind, item.id)}>
                          <ItemMedia variant="icon" className="flex size-8 rounded-md bg-muted text-muted-foreground">
                            <HugeiconsIcon icon={itemIcon(item.kind)} strokeWidth={1.8} />
                          </ItemMedia>
                          <ItemContent className="min-w-0">
                            <ItemTitle>{item.name}</ItemTitle>
                            <ItemDescription className="line-clamp-1">{item.description ?? item.path}</ItemDescription>
                          </ItemContent>
                          <ItemActions className="ml-auto shrink-0 text-muted-foreground">
                            <span className="hidden text-[0.6875rem] tabular-nums sm:inline">{displayModifiedAt(item.modifiedAt)}</span>
                            <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-3.5" />
                          </ItemActions>
                        </button>
                      </Item>
                    );
                    if (item.kind === "extension") return <div key={item.id} role="listitem">{row}</div>;
                    return (
                      <ContextMenu key={item.id}>
                        <ContextMenuTrigger asChild><div role="listitem">{row}</div></ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem onSelect={() => void openSkillAction("rename", item)}><HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />Rename</ContextMenuItem>
                          <ContextMenuItem onSelect={() => void openSkillAction("duplicate", item)}><HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />Duplicate</ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem variant="destructive" onSelect={() => void openSkillAction("delete", item)}><HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />Delete</ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                </ItemGroup>
              ) : (
                <Empty className="min-h-64 border">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><HugeiconsIcon icon={query ? Search01Icon : kind === "skill" ? BookOpen01Icon : FileCodeIcon} strokeWidth={2} /></EmptyMedia>
                    <EmptyTitle>{query ? `No ${kind}s match “${query}”` : `No ${kind}s yet`}</EmptyTitle>
                    <EmptyDescription>{query ? "Try a name, description, or path." : kind === "skill" ? "Create a skill to start writing reusable instructions." : `Add extension files under ${root ?? "your Pi extensions directory"}.`}</EmptyDescription>
                  </EmptyHeader>
                  {!query && kind === "skill" && <EmptyContent><Button onClick={() => setNameDialog({ mode: "create" })}><HugeiconsIcon icon={Add01Icon} strokeWidth={2} />New skill</Button></EmptyContent>}
                </Empty>
              )}
            </section>
          </main>
        </ScrollArea>
      )}

      {nameDialog && <NameDialog state={nameDialog} onClose={() => setNameDialog(undefined)} onSubmit={submitNameDialog} />}
      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && !deletePending && setDeleteTarget(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.item.name}?</AlertDialogTitle>
            <AlertDialogDescription>This deletes the skill and its files from Forge. This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={() => void removeSkill()} disabled={deletePending}>{deletePending ? "Deleting…" : "Delete skill"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
