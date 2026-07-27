import { normalizeSessionTitle, SESSION_TITLE_MAX_LENGTH } from "@anvil/protocol";
import { type FormEvent, useRef, useState } from "react";

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
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export function AddWorkspaceDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, path: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const nameRef = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !path.trim() || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await onCreate(name.trim(), path.trim());
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        aria-describedby="add-workspace-description"
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
            Workspace access
          </span>
          <DialogTitle>Add a workspace</DialogTitle>
          <DialogDescription id="add-workspace-description">
            Choose a directory on Forge that Pi can work inside.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="workspace-name">Name</FieldLabel>
              <Input
                ref={nameRef}
                id="workspace-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Anvil"
                maxLength={80}
                disabled={pending}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="workspace-path">Path on Forge</FieldLabel>
              <Input
                id="workspace-path"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/home/oli/code/project"
                spellCheck={false}
                disabled={pending}
                required
              />
            </Field>
          </FieldGroup>
          {error && <FieldError role="alert">{error}</FieldError>}
          <DialogFooter className="border-t border-border/60 pt-3">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || !path.trim() || pending}>
              {pending ? "Adding…" : "Add workspace"}
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
