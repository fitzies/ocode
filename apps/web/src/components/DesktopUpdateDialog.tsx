import type { Update } from "@tauri-apps/plugin-updater";
import { useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";

export function isOcodeDesktop(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.ocodeDesktop === "macos";
}

export function desktopUpdaterError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/updater.*(not found|not registered|not allowed|permission)|unknown plugin.*updater/i.test(message)) {
    return "This desktop build predates in-app updates. Build desktop version 0.1.1 on the Mac and replace the installed ocode app once; later updates can install here.";
  }
  return message;
}

type UpdateState =
  | { status: "checking"; currentVersion?: string }
  | { status: "current"; currentVersion: string }
  | { status: "available"; currentVersion: string; version: string; notes?: string }
  | { status: "installing"; currentVersion: string; version: string; downloaded: number; total?: number }
  | { status: "error"; currentVersion?: string; message: string };

export function DesktopUpdateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, setState] = useState<UpdateState>({ status: "checking" });
  const updateRef = useRef<Update | null>(null);

  const checkForUpdate = async () => {
    setState({ status: "checking" });
    try {
      const [{ getVersion }, { check }] = await Promise.all([
        import("@tauri-apps/api/app"),
        import("@tauri-apps/plugin-updater"),
      ]);
      const update = await check({ timeout: 20_000 });
      const currentVersion = await getVersion();
      if (updateRef.current && updateRef.current !== update) void updateRef.current.close();
      updateRef.current = update;
      setState(update
        ? {
            status: "available",
            currentVersion,
            version: update.version,
            notes: update.body,
          }
        : { status: "current", currentVersion });
    } catch (error) {
      setState({ status: "error", message: desktopUpdaterError(error) });
    }
  };

  useEffect(() => {
    if (!open) return;
    void checkForUpdate();
    return () => {
      if (updateRef.current) void updateRef.current.close();
      updateRef.current = null;
    };
  }, [open]);

  const installUpdate = async () => {
    const update = updateRef.current;
    if (!update || state.status !== "available") return;
    const { currentVersion, version } = state;
    let downloaded = 0;
    let total: number | undefined;
    setState({ status: "installing", currentVersion, version, downloaded });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength;
        if (event.event === "Progress") downloaded += event.data.chunkLength;
        setState({ status: "installing", currentVersion, version, downloaded, total });
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      setState({ status: "error", currentVersion, message: desktopUpdaterError(error) });
    }
  };

  const busy = state.status === "checking" || state.status === "installing";
  const progress = state.status === "installing" && state.total
    ? Math.min(100, (state.downloaded / state.total) * 100)
    : undefined;

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent onEscapeKeyDown={(event) => busy && event.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Desktop updates</AlertDialogTitle>
          <AlertDialogDescription>
            Signed macOS updates are downloaded privately from Forge and installed after confirmation.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="desktop-update-status" role="status" aria-live="polite">
          {state.status === "checking" && <><Spinner /><span><strong>Checking for updates…</strong><small>Contacting Forge</small></span></>}
          {state.status === "current" && <span><strong>ocode is up to date</strong><small>Version {state.currentVersion}</small></span>}
          {state.status === "available" && <span><strong>Version {state.version} is available</strong><small>Installed: {state.currentVersion}</small>{state.notes && <p>{state.notes}</p>}</span>}
          {state.status === "installing" && (
            <span className="desktop-update-installing">
              <strong>Installing version {state.version}…</strong>
              <small>{state.total ? `${Math.round(state.downloaded / 1_048_576)} of ${Math.round(state.total / 1_048_576)} MB` : "Downloading signed update"}</small>
              <Progress value={progress} />
            </span>
          )}
          {state.status === "error" && <span><strong>Update check failed</strong><small className="text-destructive">{state.message}</small></span>}
        </div>

        <AlertDialogFooter>
          {!busy && <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>}
          {(state.status === "current" || state.status === "error") && <Button onClick={() => void checkForUpdate()}>Check again</Button>}
          {state.status === "available" && <Button onClick={() => void installUpdate()}>Install and restart</Button>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
