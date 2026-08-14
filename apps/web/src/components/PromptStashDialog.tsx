import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";
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
import type { PromptStash } from "@/lib/promptStashes";

function stashPreview(text: string): string {
  const compact = text.trim().replace(/\s+/g, " ");
  if (!compact) return "Blank message";
  return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact;
}

function stashTimestamp(createdAt: string): string {
  const timestamp = new Date(createdAt);
  if (Number.isNaN(timestamp.getTime())) return "";
  return timestamp.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function PromptStashDialog({
  open,
  stashes,
  onOpenChange,
  onSelect,
  onDelete,
}: {
  open: boolean;
  stashes: readonly PromptStash[];
  onOpenChange: (open: boolean) => void;
  onSelect: (stash: PromptStash) => void;
  onDelete: (stash: PromptStash) => void;
}) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Stashed messages"
      description="Search for a saved message and insert it into the composer"
      className="sm:max-w-xl"
    >
      <Command>
        <CommandInput autoFocus placeholder="Search stashes…" aria-label="Search stashed messages" />
        <CommandList className="max-h-80">
          <CommandEmpty>No stashed messages found.</CommandEmpty>
          <CommandGroup heading="Stashed messages">
            {stashes.map((stash) => (
              <CommandItem
                key={stash.id}
                value={`${stash.text} ${stash.createdAt}`}
                className="group/stash min-h-10"
                onSelect={() => onSelect(stash)}
              >
                <span className="min-w-0 flex-1 truncate">{stashPreview(stash.text)}</span>
                <CommandShortcut className="hidden shrink-0 normal-case tracking-normal sm:inline">
                  {stashTimestamp(stash.createdAt)}
                </CommandShortcut>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="-mr-1 size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/stash:opacity-100 group-data-[selected=true]/stash:opacity-100 focus-visible:opacity-100"
                  aria-label={`Delete stash: ${stashPreview(stash.text)}`}
                  title="Delete stash"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(stash);
                  }}
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3" />
                </Button>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
