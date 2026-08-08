import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DEFAULT_SHORTCUTS, formatShortcutParts, loadShortcuts, saveShortcuts, shortcutFromEvent, type ShortcutId, type ShortcutMap } from "@/lib/shortcuts";

const groups: { title: string; items: [ShortcutId, string, string][] }[] = [
  { title: "Threads", items: [
    ["newThread", "New thread", "Start a thread in the current project."],
    ["closeThread", "Close thread", "Delete the currently selected thread."],
    ["nextThread", "Next thread", "Move to the next thread in this project."],
    ["previousThread", "Previous thread", "Move to the previous thread in this project."],
  ] },
  { title: "Navigation", items: [
    ["search", "Search threads", "Open thread search."],
    ["settings", "Open settings", "Open the Forge settings menu."],
    ["toggleSidebar", "Toggle sidebar", "Open or collapse the app sidebar."],
    ["terminal", "Toggle terminal", "Show or hide the project terminal."],
    ...Array.from({ length: 9 }, (_, index) => [`thread${index + 1}` as ShortcutId, `Open thread ${index + 1}`, `Jump to thread ${index + 1} in the list.`] as [ShortcutId, string, string]),
  ] },
];

function ShortcutKeys({ chord }: { chord: string }) {
  return <span className="flex items-center gap-1" aria-hidden="true">
    {formatShortcutParts(chord).map((key, index) => (
      <kbd key={`${key}-${index}`} className="inline-flex min-w-5 items-center justify-center rounded border border-border bg-transparent px-1.5 py-0.5 font-mono text-[0.6875rem] font-medium leading-4">
        {key}
      </kbd>
    ))}
  </span>;
}

function ShortcutRecorder({ value, isDefault, onChange, onReset }: {
  value: string;
  isDefault: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const record = (event: KeyboardEvent) => {
      if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        setRecording(false);
        return;
      }
      const shortcut = shortcutFromEvent(event);
      if (!shortcut) return;
      onChange(shortcut);
      setRecording(false);
    };
    window.addEventListener("keydown", record, true);
    return () => window.removeEventListener("keydown", record, true);
  }, [onChange, recording]);

  return <div className="flex w-32 shrink-0 items-center justify-end gap-1">
    <button
      type="button"
      className="flex h-7 min-w-20 items-center justify-center rounded-md px-1.5 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-[recording=true]:bg-accent"
      data-recording={recording}
      aria-pressed={recording}
      onClick={() => setRecording((current) => !current)}
    >
      {recording
        ? <span className="text-[0.6875rem] text-muted-foreground">Press keys…</span>
        : <ShortcutKeys chord={value} />}
    </button>
    {!isDefault && <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="size-7 text-muted-foreground"
      aria-label="Reset to default"
      title="Reset to default"
      onClick={onReset}
    >
      <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} className="size-3" />
    </Button>}
  </div>;
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(loadShortcuts);

  useEffect(() => {
    if (open) setShortcuts(loadShortcuts());
  }, [open]);

  const update = (id: ShortcutId, shortcut: string) => {
    setShortcuts((current) => {
      const next = { ...current, [id]: shortcut };
      saveShortcuts(next);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(38rem,calc(100dvh-2rem))] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Click a shortcut to change it. Press Escape to cancel.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5 pt-1">
          {groups.map((group) => (
            <section key={group.title}>
              <h3 className="mb-1 px-2 font-mono text-[0.625rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">{group.title}</h3>
              <div className="space-y-0.5">
                {group.items.map(([id, label]) => (
                  <div key={id} className="flex min-h-9 items-center justify-between gap-4 rounded-md px-2 transition-colors hover:bg-muted/40">
                    <span className="text-xs font-medium">{label}</span>
                    <ShortcutRecorder
                      value={shortcuts[id]}
                      isDefault={shortcuts[id] === DEFAULT_SHORTCUTS[id]}
                      onChange={(shortcut) => update(id, shortcut)}
                      onReset={() => update(id, DEFAULT_SHORTCUTS[id])}
                    />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
