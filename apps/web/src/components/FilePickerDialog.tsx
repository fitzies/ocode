import {
  ArrowLeft01Icon,
  CodeIcon,
  File01Icon,
  Loading03Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useWorkspaceSurfaces } from "@/components/workspace/WorkspaceSurfaceState";
import type { WorkspaceFile } from "@/lib/anvilClient";
import { getProjectGitStatus } from "@/lib/projectGit";

export type RichPreviewKind = "markdown" | "html";
type RichView = "preview" | "source";

export function richPreviewKind(path: string): RichPreviewKind | undefined {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (["md", "markdown", "mdx"].includes(extension ?? "")) return "markdown";
  if (["html", "htm"].includes(extension ?? "")) return "html";
  return undefined;
}

export function sortFilesByChangedLines(
  files: WorkspaceFile[],
  lineDiffs: Map<string, { additions: number; deletions: number }>,
): WorkspaceFile[] {
  const knownPaths = new Set(files.map((file) => file.path));
  const dirtyFiles = [...lineDiffs.keys()]
    .filter((path) => !knownPaths.has(path))
    .map((path) => ({ path }));
  return [...dirtyFiles, ...files]
    .map((file, index) => ({ file, index }))
    .sort((left, right) => {
      const leftDiff = lineDiffs.get(left.file.path);
      const rightDiff = lineDiffs.get(right.file.path);
      const leftLines = (leftDiff?.additions ?? 0) + (leftDiff?.deletions ?? 0);
      const rightLines = (rightDiff?.additions ?? 0) + (rightDiff?.deletions ?? 0);
      return rightLines - leftLines || left.index - right.index;
    })
    .map(({ file }) => file);
}

export function FilePickerDialog({
  open,
  projectId,
  sessionId,
  onOpenChange,
  onSearchFiles,
}: {
  open: boolean;
  projectId: string;
  sessionId: string;
  onOpenChange: (open: boolean) => void;
  onSearchFiles: (sessionId: string, query: string) => Promise<WorkspaceFile[]>;
}) {
  const { openProjectResource } = useWorkspaceSurfaces();
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [gitLoading, setGitLoading] = useState(false);
  const [lineDiffs, setLineDiffs] = useState<Map<string, { additions: number; deletions: number }>>(new Map());
  const [selectedPath, setSelectedPath] = useState<string>();
  const [selectedView, setSelectedView] = useState<RichView>("preview");
  const requestRef = useRef(0);
  const selectedKind = selectedPath ? richPreviewKind(selectedPath) : undefined;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFiles([]);
    setLineDiffs(new Map());
    setGitLoading(true);
    setSelectedPath(undefined);
    setSelectedView("preview");
    const controller = new AbortController();
    void getProjectGitStatus(projectId, controller.signal, { localOnly: true }).then((status) => {
      setLineDiffs(new Map(status.files?.map((file) => [file.path, file]) ?? []));
    }).catch(() => undefined).finally(() => {
      if (!controller.signal.aborted) setGitLoading(false);
    });
    return () => controller.abort();
  }, [open, projectId, sessionId]);

  useEffect(() => {
    if (!open || selectedPath) return;
    const request = ++requestRef.current;
    setLoading(true);
    setFiles([]);
    const timer = window.setTimeout(() => {
      void onSearchFiles(sessionId, query).then((next) => {
        if (request === requestRef.current) setFiles(next);
      }).catch(() => {
        if (request === requestRef.current) setFiles([]);
      }).finally(() => {
        if (request === requestRef.current) setLoading(false);
      });
    }, query ? 80 : 0);
    return () => {
      window.clearTimeout(timer);
      requestRef.current += 1;
    };
  }, [open, onSearchFiles, query, selectedPath, sessionId]);

  const openFile = (path: string, view?: RichView) => {
    openProjectResource({ projectId, path, ...(view ? { view } : {}) }, "picker");
    onOpenChange(false);
  };

  const chooseFile = (path: string) => {
    if (richPreviewKind(path)) {
      setSelectedView("preview");
      setSelectedPath(path);
    } else {
      openFile(path);
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      requestRef.current += 1;
      setSelectedPath(undefined);
    }
    onOpenChange(next);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Open file"
      description="Fuzzy-search files in the current project and open one in the side pane."
      className="sm:max-w-lg"
    >
      <Command
        shouldFilter={false}
        key={selectedPath ?? "file-search"}
        value={selectedPath ? selectedView : undefined}
        onValueChange={(value) => {
          if (selectedPath && (value === "preview" || value === "source")) setSelectedView(value);
        }}
        onKeyDownCapture={(event) => {
          if (!selectedPath || !["Backspace", "ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Backspace") setSelectedPath(undefined);
          else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            setSelectedView((view) => view === "preview" ? "source" : "preview");
          } else if (event.key === "Enter") openFile(selectedPath, selectedView);
        }}
      >
        {selectedPath && selectedKind ? (
          <>
            <input autoFocus readOnly value="" className="sr-only" aria-label={`Choose how to open ${selectedPath}`} />
            <div className="p-1 pb-0">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 w-full min-w-0 justify-start px-2 font-normal text-muted-foreground"
                tabIndex={-1}
                onClick={() => setSelectedPath(undefined)}
              >
                <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
                <span className="truncate font-mono text-[0.6875rem]">{selectedPath}</span>
              </Button>
            </div>
            <CommandList className="max-h-40">
              <CommandGroup>
                <CommandItem value="preview" onSelect={() => openFile(selectedPath, "preview")}>
                  <HugeiconsIcon icon={ViewIcon} strokeWidth={2} className="text-muted-foreground" />
                  {selectedKind === "markdown" ? "View rendered" : "View preview"}
                </CommandItem>
                <CommandItem value="source" onSelect={() => openFile(selectedPath, "source")}>
                  <HugeiconsIcon icon={CodeIcon} strokeWidth={2} className="text-muted-foreground" />
                  Open code
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </>
        ) : (
          <>
            <CommandInput
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Search files…"
              aria-label="Search project files"
            />
            <CommandList>
              {loading || gitLoading ? (
                <div className="grid place-items-center py-6" role="status">
                  <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
                  <span className="sr-only">Searching project files</span>
                </div>
              ) : (
                <>
                  <CommandEmpty>No matching files</CommandEmpty>
                  <CommandGroup>
                    {(query ? files : sortFilesByChangedLines(files, lineDiffs)).map((file) => {
                      const diff = lineDiffs.get(file.path);
                      return (
                        <CommandItem key={file.path} value={file.path} onSelect={() => chooseFile(file.path)}>
                          <HugeiconsIcon icon={File01Icon} strokeWidth={2} className="shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">{file.path}</span>
                          {diff && (
                            <span className="ml-auto flex shrink-0 gap-1.5 font-mono text-[0.6875rem] tabular-nums" aria-label={`${diff.additions} additions, ${diff.deletions} deletions`}>
                              <span className="text-emerald-600 dark:text-emerald-400">+{diff.additions}</span>
                              <span className="text-red-600 dark:text-red-400">−{diff.deletions}</span>
                            </span>
                          )}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </>
        )}
      </Command>
    </CommandDialog>
  );
}
