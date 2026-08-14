import type { ProjectSummary, SessionSummary } from "@anvil/protocol";
import { useState } from "react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";

const RECENT_WINDOW_MS = 15 * 60 * 1_000;

function relativeTime(timestamp: string): string {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 60_000));
  return elapsedMinutes < 1 ? "just now" : `${elapsedMinutes}m ago`;
}

export function RecentlySettledDialog({
  open,
  sessions,
  projects,
  onOpenChange,
  onRestore,
}: {
  open: boolean;
  sessions: readonly SessionSummary[];
  projects: readonly ProjectSummary[];
  onOpenChange: (open: boolean) => void;
  onRestore: (sessionId: string) => Promise<void>;
}) {
  const [pendingId, setPendingId] = useState<string>();
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const recent = sessions
    .filter((session) => session.settled && Date.parse(session.updatedAt) >= cutoff)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));

  const restore = async (session: SessionSummary) => {
    if (pendingId) return;
    setPendingId(session.id);
    try {
      await onRestore(session.id);
      onOpenChange(false);
    } finally {
      setPendingId(undefined);
    }
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Recently settled threads"
      description="Restore a thread settled in the last 15 minutes"
      className="sm:max-w-xl"
    >
      <Command>
        <CommandInput autoFocus placeholder="Search recently settled threads…" aria-label="Search recently settled threads" />
        <CommandList className="max-h-80">
          <CommandEmpty>No threads settled in the last 15 minutes.</CommandEmpty>
          <CommandGroup heading="Recently settled">
            {recent.map((session) => (
              <CommandItem
                key={session.id}
                value={`${session.title} ${projectNames.get(session.projectId) ?? ""}`}
                disabled={Boolean(pendingId)}
                onSelect={() => void restore(session)}
              >
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {projectNames.get(session.projectId) ?? "Unknown project"}
                </span>
                <CommandShortcut className="normal-case tracking-normal">
                  {pendingId === session.id ? "Restoring…" : relativeTime(session.updatedAt)}
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
