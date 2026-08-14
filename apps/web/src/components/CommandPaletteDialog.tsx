import { BotIcon, GithubIcon } from "@hugeicons/core-free-icons";
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
  const { projectId, openSidePage } = useWorkspaceSurfaces();

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
          <CommandGroup heading="Workspace">
            <CommandItem
              value="Open GitHub activity commits changes checks repository"
              disabled={!projectId}
              onSelect={() => {
                openSidePage("git");
                onOpenChange(false);
              }}
            >
              <HugeiconsIcon icon={GithubIcon} strokeWidth={2} className="text-muted-foreground" />
              Open GitHub activity
            </CommandItem>
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
