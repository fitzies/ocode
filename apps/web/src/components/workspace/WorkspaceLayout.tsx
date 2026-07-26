import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { MobileWorkspaceSurface } from "@/lib/workspace";

export type WorkspaceLayoutSlots = {
  main: ReactNode;
  bottom?: ReactNode;
  right?: ReactNode;
};

export type WorkspaceLayoutProps = WorkspaceLayoutSlots & {
  isMobile: boolean;
  mobileSurface?: MobileWorkspaceSurface;
  onMobileSurfaceChange?: (surface: MobileWorkspaceSurface) => void;
};

function DesktopLeftStack({ main, bottom }: Pick<WorkspaceLayoutSlots, "main" | "bottom">) {
  if (bottom === undefined || bottom === null) {
    return <div className="workspace-layout-main">{main}</div>;
  }

  return (
    <ResizablePanelGroup direction="vertical" className="workspace-layout-stack">
      <ResizablePanel id="workspace-main" minSize="30%" defaultSize="70%">
        <div className="workspace-layout-main">{main}</div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="workspace-bottom" minSize="15%" defaultSize="30%">
        <section className="workspace-layout-surface workspace-layout-bottom" aria-label="Project terminal surface">
          {bottom}
        </section>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function DesktopWorkspace({ main, bottom, right }: WorkspaceLayoutSlots) {
  if (right === undefined || right === null) {
    return (
      <div className="workspace-layout-desktop" data-workspace-layout="desktop">
        <DesktopLeftStack main={main} bottom={bottom} />
      </div>
    );
  }

  return (
    <div className="workspace-layout-desktop" data-workspace-layout="desktop">
      <ResizablePanelGroup direction="horizontal">
        <ResizablePanel id="workspace-left" minSize="40%" defaultSize="72%">
          <DesktopLeftStack main={main} bottom={bottom} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="workspace-right" minSize="18%" defaultSize="28%">
          <aside className="workspace-layout-surface workspace-layout-right" aria-label="Project resource surface">
            {right}
          </aside>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function MobileWorkspace({
  main,
  bottom,
  right,
  mobileSurface = "conversation",
  onMobileSurfaceChange,
}: Omit<WorkspaceLayoutProps, "isMobile">) {
  const requested = mobileSurface === "terminal"
    ? bottom
    : mobileSurface === "resource"
      ? right
      : main;
  const activeSurface = requested === undefined || requested === null ? "conversation" : mobileSurface;
  const content = activeSurface === "terminal" ? bottom : activeSurface === "resource" ? right : main;
  const title = activeSurface === "terminal" ? "Terminal" : "Resource";

  return (
    <div
      className={`workspace-layout-mobile workspace-layout-mobile--${activeSurface}`}
      data-workspace-layout="mobile"
      data-mobile-surface={activeSurface}
    >
      {activeSurface !== "conversation" && (
        <header className="workspace-mobile-header">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="workspace-mobile-back"
            onClick={() => onMobileSurfaceChange?.("conversation")}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
            Conversation
          </Button>
          <strong>{title}</strong>
          <span aria-hidden="true" />
        </header>
      )}
      <div className="workspace-layout-mobile-content">{content}</div>
    </div>
  );
}

export function WorkspaceLayout(props: WorkspaceLayoutProps) {
  return props.isMobile ? <MobileWorkspace {...props} /> : <DesktopWorkspace {...props} />;
}
