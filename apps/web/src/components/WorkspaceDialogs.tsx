import { isGeneralProject, normalizeSessionTitle, SESSION_TITLE_MAX_LENGTH, type ProjectSummary, type SessionSummary } from "@anvil/protocol";
import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { terminalClient } from "@/lib/terminalClient";

export function projectThreadCount(projectId: string, sessions: readonly SessionSummary[]): number {
  return sessions.filter((session) => session.projectId === projectId && !session.internal).length;
}

export function projectRemovalConfirmationMatches(projectName: string, threadCount: number, confirmation: string): boolean {
  return threadCount === 0 || confirmation === projectName;
}

export function projectRemovalWarning(threadCount: number, terminalCount?: number): string {
  const threads = `${threadCount} ${threadCount === 1 ? "thread" : "threads"}`;
  const terminals = terminalCount === undefined
    ? "terminal records and history"
    : `${terminalCount} ${terminalCount === 1 ? "terminal" : "terminals"} and their history`;
  return `Active work will be stopped. ocode will permanently remove ${threads}, Pi sessions, artifacts, pending requests, and ${terminals}. Workspace files remain untouched on disk.`;
}

function useProjectTerminalCount(projectId: string | undefined): number | undefined {
  const terminals = useSyncExternalStore(
    terminalClient.subscribe,
    () => terminalClient.terminals(projectId ?? ""),
    () => terminalClient.terminals(projectId ?? ""),
  );
  const loaded = useSyncExternalStore(
    terminalClient.subscribe,
    () => projectId ? terminalClient.projectLoaded(projectId) : false,
    () => projectId ? terminalClient.projectLoaded(projectId) : false,
  );
  useEffect(() => projectId ? terminalClient.watchProject(projectId) : undefined, [projectId]);
  return loaded ? terminals.length : undefined;
}

function ProjectRetentionSummary({ projectId, threadCount }: { projectId: string; threadCount: number }) {
  const terminalCount = useProjectTerminalCount(projectId);
  return (
    <span className="text-xs text-muted-foreground">
      {threadCount} {threadCount === 1 ? "thread" : "threads"}
      <span aria-hidden="true"> · </span>
      {terminalCount === undefined
        ? "Loading terminals…"
        : `${terminalCount} ${terminalCount === 1 ? "terminal" : "terminals"}`}
    </span>
  );
}

export function ProjectsRootDialog({
  onClose,
  onGet,
  onSave,
}: {
  onClose: () => void;
  onGet: () => Promise<string>;
  onSave: (path: string) => Promise<string>;
}) {
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void onGet().then((value) => {
      if (cancelled) return;
      setPath(value);
      setLoading(false);
    }).catch((failure) => {
      if (cancelled) return;
      setError(failure instanceof Error ? failure.message : String(failure));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [onGet]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!path.trim() || loading || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await onSave(path.trim());
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        aria-describedby="projects-root-description"
        className="sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onPointerDownOutside={(event) => pending && event.preventDefault()}
      >
        <DialogHeader>
          <span className="font-mono text-[0.625rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Forge settings
          </span>
          <DialogTitle>Projects root</DialogTitle>
          <DialogDescription id="projects-root-description">
            New projects are created as directories inside this location on Forge.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <Field>
            <FieldLabel htmlFor="projects-root-path">Absolute path</FieldLabel>
            <Input
              ref={inputRef}
              id="projects-root-path"
              value={path}
              onChange={(event) => {
                setPath(event.target.value);
                setError(undefined);
              }}
              placeholder={loading ? "Loading…" : "/code"}
              disabled={pending}
              readOnly={loading}
              spellCheck={false}
              autoComplete="off"
              className="font-mono"
              aria-invalid={Boolean(error) || undefined}
              required
            />
            <FieldDescription>The directory must already exist and be readable and writable by Forge.</FieldDescription>
          </Field>
          {error && <FieldError role="alert">{error}</FieldError>}
          <DialogFooter className="border-t border-border/60 pt-3">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!path.trim() || loading || pending}>
              {pending ? "Saving…" : "Save projects root"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ManageProjectsDialog({
  projects,
  sessions,
  onClose,
  onRemove,
}: {
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  onClose: () => void;
  onRemove: (projectId: string) => Promise<void>;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [confirmationName, setConfirmationName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const threadCount = selectedProject ? projectThreadCount(selectedProject.id, sessions) : 0;
  const terminalCount = useProjectTerminalCount(selectedProject?.id);
  const requiresTypedConfirmation = threadCount > 0;
  const confirmed = selectedProject
    ? projectRemovalConfirmationMatches(selectedProject.name, threadCount, confirmationName)
    : false;

  useEffect(() => {
    setConfirmationName("");
    setError(undefined);
  }, [selectedProjectId]);

  useEffect(() => {
    if (selectedProjectId && !projects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(undefined);
      setPending(false);
    }
  }, [projects, selectedProjectId]);

  const returnToList = () => {
    if (pending) return;
    setSelectedProjectId(undefined);
  };

  const remove = async () => {
    if (!selectedProject || pending || !confirmed) return;
    setPending(true);
    setError(undefined);
    try {
      await onRemove(selectedProject.id);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        className="sm:max-w-xl"
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
      >
        {selectedProject ? (
          <>
            <DialogHeader>
              <span className="font-mono text-[0.625rem] font-medium uppercase tracking-[0.12em] text-destructive">
                Destructive action
              </span>
              <DialogTitle>Remove “{selectedProject.name}” from ocode?</DialogTitle>
              <DialogDescription>
                {projectRemovalWarning(threadCount, terminalCount)}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
              <div>
                <span className="block text-xs text-muted-foreground">Project</span>
                <strong>{selectedProject.name}</strong>
              </div>
              <div className="min-w-0">
                <span className="block text-xs text-muted-foreground">Workspace path</span>
                <code className="block break-all text-xs">{selectedProject.path}</code>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="block text-xs text-muted-foreground">Threads removed</span>
                  <strong>{threadCount}</strong>
                </div>
                <div>
                  <span className="block text-xs text-muted-foreground">Terminals removed</span>
                  <strong>{terminalCount ?? "Loading…"}</strong>
                </div>
              </div>
              <p className="font-medium text-foreground">Workspace files remain untouched on disk.</p>
            </div>
            {requiresTypedConfirmation && (
              <Field>
                <FieldLabel htmlFor="remove-project-confirmation">
                  Type <strong>{selectedProject.name}</strong> to confirm
                </FieldLabel>
                <Input
                  id="remove-project-confirmation"
                  autoComplete="off"
                  value={confirmationName}
                  onChange={(event) => setConfirmationName(event.target.value)}
                  disabled={pending}
                  aria-invalid={Boolean(error) || undefined}
                />
              </Field>
            )}
            {error && <FieldError role="alert">{error}</FieldError>}
            <DialogFooter className="border-t border-border/60 pt-3">
              <Button type="button" variant="outline" onClick={returnToList} disabled={pending}>Cancel</Button>
              <Button variant="destructive" onClick={() => void remove()} disabled={pending || !confirmed}>
                {pending ? "Removing…" : "Remove from ocode"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <span className="font-mono text-[0.625rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Forge settings
              </span>
              <DialogTitle>Manage projects</DialogTitle>
              <DialogDescription>
                Remove projects from ocode without changing their workspace files on disk.
              </DialogDescription>
            </DialogHeader>
            <div className="grid max-h-[min(28rem,60vh)] gap-2 overflow-y-auto" aria-label="Registered projects">
              {projects.map((project) => {
                const count = projectThreadCount(project.id, sessions);
                const general = isGeneralProject(project);
                return (
                  <div key={project.id} className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <strong className="block truncate text-sm">{project.name}</strong>
                      <span className="block truncate font-mono text-xs text-muted-foreground" title={project.path}>{general ? "~/" : project.path}</span>
                      <ProjectRetentionSummary projectId={project.id} threadCount={count} />
                    </div>
                    {general ? (
                      <span className="shrink-0 rounded-sm bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">Built in</span>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0 text-destructive hover:text-destructive"
                        aria-label={`Remove ${project.name} from ocode`}
                        onClick={() => setSelectedProjectId(project.id)}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                );
              })}
              {projects.length === 0 && (
                <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                  No projects are registered with ocode.
                </div>
              )}
            </div>
            <DialogFooter className="border-t border-border/60 pt-3">
              <Button type="button" variant="outline" onClick={onClose}>Close</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RenameThreadDialog({
  title: initialTitle,
  onClose,
  onRename,
}: {
  title: string;
  onClose: () => void;
  onRename: (title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedTitle = normalizeSessionTitle(title);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!normalizedTitle || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await onRename(normalizedTitle);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        aria-describedby="rename-thread-description"
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
          inputRef.current?.select();
        }}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onPointerDownOutside={(event) => pending && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Rename thread</DialogTitle>
          <DialogDescription id="rename-thread-description">
            Choose a short, descriptive title for this thread.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <Field>
            <FieldLabel htmlFor="thread-title">Thread title</FieldLabel>
            <Input
              ref={inputRef}
              id="thread-title"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setError(undefined);
              }}
              maxLength={SESSION_TITLE_MAX_LENGTH}
              disabled={pending}
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={error ? "rename-thread-error" : undefined}
              required
            />
          </Field>
          {error && <FieldError id="rename-thread-error" role="alert">{error}</FieldError>}
          <DialogFooter className="border-t border-border/60 pt-3">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!normalizedTitle || pending}>
              {pending ? "Renaming…" : "Rename thread"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteThreadDialog({
  title,
  onClose,
  onDelete,
}: {
  title: string;
  onClose: (deleted?: boolean) => void;
  onDelete: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const remove = async () => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      await onDelete();
      onClose(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPending(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialogContent
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="max-w-full truncate">Delete “{title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the conversation and its Pi session files. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <FieldError role="alert">{error}</FieldError>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={() => void remove()} disabled={pending}>
            {pending ? "Deleting…" : "Delete thread"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
