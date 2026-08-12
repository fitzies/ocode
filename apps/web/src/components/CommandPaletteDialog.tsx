import { BotIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useWorkspaceSurfaces } from "@/components/workspace/WorkspaceSurfaceState";

export function CommandPaletteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { openSidePage } = useWorkspaceSurfaces();

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Commands"
      description="Search and run a workspace command"
      className="sm:max-w-lg"
    >
      <Command>
        <CommandInput autoFocus placeholder="Search commands…" aria-label="Search commands" />
        <CommandList>
          <CommandEmpty>No commands found.</CommandEmpty>
          <CommandGroup heading="Commands">
            <CommandItem
              value="View Agents"
              onSelect={() => {
                openSidePage("agents");
                onOpenChange(false);
              }}
            >
              <HugeiconsIcon icon={BotIcon} strokeWidth={2} className="text-muted-foreground" />
              View Agents
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
