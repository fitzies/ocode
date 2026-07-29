import { normalizeProjectSlug, normalizeSessionTitle, SESSION_TITLE_MAX_LENGTH } from "@anvil/protocol";
import { type FormEvent, useEffect, useRef, useState } from "react";

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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

function projectPath(root: string, slug: string): string {
  return `${root.replace(/\/$/, "")}/${slug}`;
}

export function NewProjectDialog({
  onClose,
  onCreate,
  onAddExisting,
  getProjectsRoot,
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<{ status: "created" } | { status: "existing"; path: string }>;
  onAddExisting: (name: string, path: string) => Promise<void>;
  getProjectsRoot: () => Promise<string>;
}) {
  const [name, setName] = useState("");
  const [projectsRoot, setProjectsRoot] = useState<string>();
  const [rootError, setRootError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [existingPath, setExistingPath] = useState<string>();
  const [error, setError] = useState<string>();
  const nameRef = useRef<HTMLInputElement>(null);
  const slug = normalizeProjectSlug(name);
  const preview = projectsRoot
    ? projectPath(projectsRoot, slug || "project-name")
    : "Loading projects root…";

  useEffect(() => {
    let cancelled = false;
    void getProjectsRoot().then((path) => {
      if (!cancelled) setProjectsRoot(path);
    }).catch((failure) => {
      if (!cancelled) setRootError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => { cancelled = true; };
  }, [getProjectsRoot]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !slug || !projectsRoot || pending) return;
    setPending(true);
    setError(undefined);
    try {
      if (existingPath) {
        await onAddExisting(name.trim(), existingPath);
        onClose();
        return;
      }
      const result = await onCreate(name.trim());
      if (result.status === "existing") {
        setExistingPath(result.path);
        setPending(false);
        return;
      }
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        aria-describedby="new-project-description"
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          nameRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onPointerDownOutside={(event) => pending && event.preventDefault()}
      >
        <DialogHeader>
          <span className="font-mono text-[0.625rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Forge projects
          </span>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription id="new-project-description">
            Name your project. Forge will create its directory under the configured projects root.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-name">Name</FieldLabel>
              <Input
                ref={nameRef}
                id="project-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setExistingPath(undefined);
                  setError(undefined);
                }}
                placeholder="My project"
                maxLength={80}
                disabled={pending}
                aria-invalid={(Boolean(name.trim()) && !slug) || undefined}
                required
              />
              {name.trim() && !slug && <FieldDescription>Use a name containing letters or numbers.</FieldDescription>}
            </Field>
            <Field>
              <FieldLabel htmlFor="project-path-preview">Directory on Forge</FieldLabel>
              <Input
                id="project-path-preview"
                value={preview}
                readOnly
                spellCheck={false}
                aria-label="New project path preview"
                className="font-mono text-xs text-muted-foreground"
              />
            </Field>
          </FieldGroup>
          {existingPath && (
            <div className="rounded-md border border-border bg-muted/35 px-3 py-2.5 text-xs" role="status">
              <strong className="block text-foreground">Project directory found</strong>
              <span className="text-muted-foreground">Forge will add this existing directory without changing its contents.</span>
            </div>
          )}
          {(rootError || error) && <FieldError role="alert">{rootError ?? error}</FieldError>}
          <DialogFooter className="border-t border-border/60 pt-3">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || !slug || !projectsRoot || pending}>
              {pending
                ? existingPath ? "Adding…" : "Checking…"
                : existingPath ? "Add existing project" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
