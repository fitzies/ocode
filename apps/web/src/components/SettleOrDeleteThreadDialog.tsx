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
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          settleButtonRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="max-w-full truncate">Settle or delete “{title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Settle moves this thread out of your active list and keeps its history. Delete permanently removes the conversation and its Pi session files.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <FieldError role="alert">{error}</FieldError>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => void perform("delete")}
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            {pendingAction === "delete" ? "Deleting…" : "Delete"}
          </Button>
          <Button
            ref={settleButtonRef}
            type="button"
            disabled={pending}
            onClick={() => void perform(DEFAULT_THREAD_CLOSE_ACTION)}
          >
            <HugeiconsIcon icon={Archive01Icon} strokeWidth={2} />
            {pendingAction === "settle" ? "Settling…" : "Settle"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
