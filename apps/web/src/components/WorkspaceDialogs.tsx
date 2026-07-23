import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

function trapFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "Tab") return;
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
    ),
  );
  if (!controls.length) return;
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

function useDialogLifecycle(onClose: () => void, focusRef: React.RefObject<HTMLElement | null>) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => focusRef.current?.focus());
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [focusRef]);
}

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
  const requestClose = () => {
    if (!pending) onClose();
  };
  useDialogLifecycle(requestClose, nameRef);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !path.trim() || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await onCreate(name, path);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPending(false);
    }
  };

  return (
    <div className="dialog-backdrop action-backdrop" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <div className="action-dialog" role="dialog" aria-modal="true" aria-labelledby="add-workspace-title" onKeyDown={trapFocus}>
        <div className="action-dialog-head">
          <span className="action-dialog-kicker">Workspace access</span>
          <h2 id="add-workspace-title">Add a workspace</h2>
          <p>Choose a directory on Forge that Pi can work inside.</p>
        </div>
        <form className="action-dialog-form" onSubmit={submit}>
          <label className="action-field">
            <span>Name</span>
            <input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} placeholder="Anvil" maxLength={80} disabled={pending} required />
          </label>
          <label className="action-field">
            <span>Path on Forge</span>
            <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/home/oli/code/project" spellCheck={false} disabled={pending} required />
          </label>
          {error && <p className="action-error" role="alert">{error}</p>}
          <div className="action-dialog-footer">
            <button type="button" className="action-button action-button--quiet" onClick={requestClose} disabled={pending}>Cancel</button>
            <button type="submit" className="action-button action-button--primary" disabled={!name.trim() || !path.trim() || pending}>{pending ? "Adding…" : "Add workspace"}</button>
          </div>
        </form>
      </div>
    </div>
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
  const cancelRef = useRef<HTMLButtonElement>(null);
  const requestClose = () => {
    if (!pending) onClose();
  };
  useDialogLifecycle(requestClose, cancelRef);

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
    <div className="dialog-backdrop action-backdrop" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <div className="action-dialog action-dialog--danger" role="alertdialog" aria-modal="true" aria-labelledby="delete-thread-title" aria-describedby="delete-thread-description" onKeyDown={trapFocus}>
        <div className="action-dialog-head">
          <span className="action-dialog-kicker">Delete thread</span>
          <h2 id="delete-thread-title">{title}</h2>
          <p id="delete-thread-description">This removes the conversation and its Pi session files. This cannot be undone.</p>
        </div>
        <div className="action-dialog-form">
          {error && <p className="action-error" role="alert">{error}</p>}
          <div className="action-dialog-footer">
            <button ref={cancelRef} type="button" className="action-button action-button--quiet" onClick={requestClose} disabled={pending}>Cancel</button>
            <button type="button" className="action-button action-button--danger" onClick={() => void remove()} disabled={pending}>{pending ? "Deleting…" : "Delete"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
