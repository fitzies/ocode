import * as React from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { cn } from "@/lib/utils";

function ResizablePanelGroup({
  className,
  direction,
  ...props
}: Omit<React.ComponentProps<typeof Group>, "orientation"> & {
  direction: "horizontal" | "vertical";
}) {
  return (
    <Group
      data-slot="resizable-panel-group"
      orientation={direction}
      className={cn("flex size-full aria-[orientation=vertical]:flex-col", className)}
      {...props}
    />
  );
}

const ResizablePanel = Panel;

function ResizableHandle({
  withHandle = false,
  className,
  ...props
}: React.ComponentProps<typeof Separator> & { withHandle?: boolean }) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        "group relative z-10 flex w-px shrink-0 items-center justify-center bg-border outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:inset-y-auto aria-[orientation=horizontal]:after:top-1/2 aria-[orientation=horizontal]:after:h-2 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:-translate-y-1/2 aria-[orientation=horizontal]:after:translate-x-0",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <span className="z-10 flex h-5 w-1.5 items-center justify-center rounded-full border border-border bg-background shadow-sm group-aria-[orientation=horizontal]:h-1.5 group-aria-[orientation=horizontal]:w-5">
          <span className="h-2.5 w-px bg-muted-foreground/50 group-aria-[orientation=horizontal]:h-px group-aria-[orientation=horizontal]:w-2.5" />
        </span>
      )}
    </Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
