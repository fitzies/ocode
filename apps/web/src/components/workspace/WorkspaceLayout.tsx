import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, type ReactNode } from "react";
import { usePanelRef } from "react-resizable-panels";

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
  mobileResourceTitle?: string;
  onMobileSurfaceChange?: (surface: MobileWorkspaceSurface) => void;
};

function DesktopWorkspace({ main, bottom, right }: WorkspaceLayoutSlots) {
  const bottomPanelRef = usePanelRef();
  const rightPanelRef = usePanelRef();
  const bottomVisible = bottom !== undefined && bottom !== null;
  const rightVisible = right !== undefined && right !== null;
  const previousBottomVisible = useRef(bottomVisible);
  const previousRightVisible = useRef(rightVisible);

  useEffect(() => {
    if (bottomVisible && !previousBottomVisible.current) bottomPanelRef.current?.resize("40%");
    else if (!bottomVisible) bottomPanelRef.current?.collapse();
    previousBottomVisible.current = bottomVisible;
  }, [bottomPanelRef, bottomVisible]);
  useEffect(() => {
    if (rightVisible && !previousRightVisible.current) rightPanelRef.current?.resize("28%");
    else if (!rightVisible) rightPanelRef.current?.collapse();
    previousRightVisible.current = rightVisible;
  }, [rightPanelRef, rightVisible]);

  return (
    <div className="workspace-layout-desktop" data-workspace-layout="desktop">
      <ResizablePanelGroup direction="horizontal">
        <ResizablePanel id="workspace-left" minSize="40%" defaultSize={rightVisible ? "72%" : "100%"}>
          <ResizablePanelGroup direction="vertical" className="workspace-layout-stack">
            <ResizablePanel id="workspace-main" minSize="30%" defaultSize={bottomVisible ? "60%" : "100%"}>
              <div className="workspace-layout-main">{main}</div>
            </ResizablePanel>
            <ResizableHandle withHandle className={bottomVisible ? "workspace-layout-terminal-handle" : "workspace-layout-handle--hidden"} disabled={!bottomVisible} />
            <ResizablePanel
              id="workspace-bottom"
              panelRef={bottomPanelRef}
              minSize="22%"
              defaultSize="40%"
              collapsedSize="0%"
              collapsible
              disabled={!bottomVisible}
            >
              <section className="workspace-layout-surface workspace-layout-bottom" aria-label="Project terminal surface" hidden={!bottomVisible}>
                {bottom}
              </section>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
        <ResizableHandle withHandle className={rightVisible ? undefined : "workspace-layout-handle--hidden"} disabled={!rightVisible} />
        <ResizablePanel
          id="workspace-right"
          panelRef={rightPanelRef}
          minSize="18%"
          defaultSize={rightVisible ? "28%" : "0%"}
          collapsedSize="0%"
          collapsible
          disabled={!rightVisible}
        >
          <aside className="workspace-layout-surface workspace-layout-right" aria-label="Project resource surface" hidden={!rightVisible}>
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
  mobileResourceTitle = "Files",
  onMobileSurfaceChange,
}: Omit<WorkspaceLayoutProps, "isMobile">) {
  const requested = mobileSurface === "terminal"
    ? bottom
    : mobileSurface === "resource"
      ? right
      : main;
  const activeSurface = requested === undefined || requested === null ? "conversation" : mobileSurface;
  const content = activeSurface === "terminal" ? bottom : activeSurface === "resource" ? right : main;
  const title = activeSurface === "terminal" ? "Terminal" : mobileResourceTitle;

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
