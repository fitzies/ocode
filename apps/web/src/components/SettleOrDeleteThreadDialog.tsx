import { Archive01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState } from "react";

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
import { FieldError } from "@/components/ui/field";

export const DEFAULT_THREAD_CLOSE_ACTION = "settle" as const;

export function SettleOrDeleteThreadDialog({
  title,
  onClose,
  onSettle,
  onDelete,
}: {
  title: string;
  onClose: (result?: "settled" | "deleted") => void;
  onSettle: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [pendingAction, setPendingAction] = useState<"settle" | "delete">();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string>();
  const settleButtonRef = useRef<HTMLButtonElement>(null);
  const pending = pendingAction !== undefined;

  const perform = async (action: "settle" | "delete") => {
    if (pending) return;
    setPendingAction(action);
    setError(undefined);
    try {
      if (action === "settle") await onSettle();
      else await onDelete();
      onClose(action === "settle" ? "settled" : "deleted");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPendingAction(undefined);
    }
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          settleButtonRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
      >
        {confirmingDelete ? (
          <>
            <AlertDialogHeader>
              <div className="mb-2 flex size-9 items-center justify-center rounded-md border border-destructive/20 bg-destructive/10 text-destructive">
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              </div>
              <AlertDialogTitle className="max-w-full truncate">Delete “{title}” permanently?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the conversation and its Pi session files. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error && <FieldError role="alert">{error}</FieldError>}
            <AlertDialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setConfirmingDelete(false)}>
                Back
              </Button>
              <Button type="button" variant="destructive" disabled={pending} onClick={() => void perform("delete")}>
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                {pendingAction === "delete" ? "Deleting…" : "Delete permanently"}
              </Button>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="max-w-full truncate">Settle “{title}”?</AlertDialogTitle>
              <AlertDialogDescription>
                It’ll leave your active list, but its conversation and Pi session files will stay available.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error && <FieldError role="alert">{error}</FieldError>}
            <AlertDialogFooter>
              <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmingDelete(true)}>
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                Delete permanently…
              </Button>
            </AlertDialogFooter>
            <div className="flex justify-end gap-2 border-t pt-3">
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <Button
                ref={settleButtonRef}
                type="button"
                disabled={pending}
                onClick={() => void perform(DEFAULT_THREAD_CLOSE_ACTION)}
              >
                <HugeiconsIcon icon={Archive01Icon} strokeWidth={2} />
                {pendingAction === "settle" ? "Settling…" : "Settle session"}
              </Button>
            </div>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
