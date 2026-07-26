import type { ShellTerminalMetadata } from "@anvil/protocol";
import {
  Add01Icon,
  ArrowReloadHorizontalIcon,
  Cancel01Icon,
  ComputerTerminal01Icon,
  Delete02Icon,
  DragDropHorizontalIcon,
  DragDropVerticalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { terminalClient } from "@/lib/terminalClient";
import { useWorkspaceSurfaces } from "@/components/workspace/WorkspaceSurfaceState";
import { TerminalViewport } from "./TerminalViewport";

export type TerminalGroup = {
  id: string;
  terminalIds: string[];
  direction: "horizontal" | "vertical";
};

type ProjectTerminalUiState = {
  groups: TerminalGroup[];
  activeGroupId?: string;
  activeTerminalId?: string;
};

const MAX_VISIBLE_PANES = 4;

function reconcileUi(state: ProjectTerminalUiState, terminals: ShellTerminalMetadata[]): ProjectTerminalUiState {
  const ids = new Set(terminals.map((terminal) => terminal.terminalId));
  const groups = state.groups
    .map((group) => ({ ...group, terminalIds: group.terminalIds.filter((id) => ids.has(id)) }))
    .filter((group) => group.terminalIds.length > 0);
  const grouped = new Set(groups.flatMap((group) => group.terminalIds));
  for (const terminal of terminals) {
    if (!grouped.has(terminal.terminalId)) {
      groups.push({ id: crypto.randomUUID(), terminalIds: [terminal.terminalId], direction: "horizontal" });
    }
  }
  const activeGroupId = groups.some((group) => group.id === state.activeGroupId)
    ? state.activeGroupId
    : groups[0]?.id;
  const activeGroup = groups.find((group) => group.id === activeGroupId);
  const activeTerminalId = activeGroup?.terminalIds.includes(state.activeTerminalId ?? "")
    ? state.activeTerminalId
    : activeGroup?.terminalIds[0];
  return { groups, activeGroupId, activeTerminalId };
}

function TerminalPane({
  terminal,
  onClose,
  onActivate,
}: {
  terminal: ShellTerminalMetadata;
  onClose(): void;
  onActivate(): void;
}) {
  return (
    <section className="terminal-pane" onFocusCapture={onActivate} aria-label={terminal.label}>
      <header className="terminal-pane-header">
        <span className={`terminal-status terminal-status--${terminal.status}`} aria-hidden="true" />
        <span className="terminal-pane-label">{terminal.label}</span>
        <span className="terminal-pane-state">{terminal.status}</span>
        {terminal.status !== "running" && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Restart ${terminal.label}`}
            onClick={() => void terminalClient.restart(terminal.projectId, terminal.terminalId).catch((error) => toast.error(error.message))}
          >
            <HugeiconsIcon icon={ArrowReloadHorizontalIcon} strokeWidth={2} />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Clear ${terminal.label}`}
          onClick={() => void terminalClient.clear(terminal.projectId, terminal.terminalId).catch((error) => toast.error(error.message))}
        >
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={`Close ${terminal.label}`} onClick={onClose}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </header>
      <div className="terminal-pane-body">
        <TerminalViewport projectId={terminal.projectId} terminalId={terminal.terminalId} />
      </div>
    </section>
  );
}

export function ProjectTerminalSurface({ projectId, isMobile }: { projectId: string; isMobile: boolean }) {
  const terminals = useSyncExternalStore(
    terminalClient.subscribe,
    () => terminalClient.terminals(projectId),
    () => terminalClient.terminals(projectId),
  );
  const connection = useSyncExternalStore(
    terminalClient.subscribe,
    terminalClient.connectionState,
    terminalClient.connectionState,
  );
  const { setBottomVisible } = useWorkspaceSurfaces();
  const [states, setStates] = useState<Record<string, ProjectTerminalUiState>>({});
  const state = states[projectId] ?? { groups: [] };

  useEffect(() => terminalClient.watchProject(projectId), [projectId]);
  useEffect(() => {
    setStates((current) => ({
      ...current,
      [projectId]: reconcileUi(current[projectId] ?? { groups: [] }, terminals),
    }));
  }, [projectId, terminals]);

  const activeGroup = state.groups.find((group) => group.id === state.activeGroupId) ?? state.groups[0];
  const byId = useMemo(() => new Map(terminals.map((terminal) => [terminal.terminalId, terminal])), [terminals]);
  const visibleIds = isMobile
    ? [state.activeTerminalId ?? activeGroup?.terminalIds[0]].filter((id): id is string => Boolean(id))
    : activeGroup?.terminalIds ?? [];

  const update = (next: (current: ProjectTerminalUiState) => ProjectTerminalUiState) => {
    setStates((current) => ({ ...current, [projectId]: next(current[projectId] ?? { groups: [] }) }));
  };
  const openTab = async () => {
    try {
      const terminal = await terminalClient.open(projectId);
      update((current) => {
        const group = { id: crypto.randomUUID(), terminalIds: [terminal.terminalId], direction: "horizontal" as const };
        return { ...current, groups: [...current.groups, group], activeGroupId: group.id, activeTerminalId: terminal.terminalId };
      });
    } catch (error) {
      toast.error("Terminal could not be opened", { description: error instanceof Error ? error.message : String(error) });
    }
  };
  const split = async (direction: TerminalGroup["direction"]) => {
    if (!activeGroup || activeGroup.terminalIds.length >= MAX_VISIBLE_PANES) return;
    try {
      const terminal = await terminalClient.open(projectId);
      update((current) => ({
        ...current,
        groups: current.groups.map((group) => group.id === activeGroup.id
          ? { ...group, direction, terminalIds: [...group.terminalIds, terminal.terminalId] }
          : group),
        activeTerminalId: terminal.terminalId,
      }));
    } catch (error) {
      toast.error("Terminal could not be split", { description: error instanceof Error ? error.message : String(error) });
    }
  };
  const closeTerminal = async (terminalId: string) => {
    try {
      await terminalClient.close(projectId, terminalId);
      update((current) => reconcileUi(current, terminals.filter((terminal) => terminal.terminalId !== terminalId)));
    } catch (error) {
      toast.error("Terminal could not be closed", { description: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="project-terminal-surface">
      <header className="terminal-toolbar">
        <div className="terminal-tabs" role="tablist" aria-label="Terminal groups">
          {(isMobile ? terminals.map((terminal) => ({ id: terminal.terminalId, terminalIds: [terminal.terminalId] })) : state.groups).map((group, index) => {
            const terminal = byId.get(group.terminalIds[0]!);
            const active = isMobile ? state.activeTerminalId === terminal?.terminalId : activeGroup?.id === group.id;
            return (
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className={`terminal-tab ${active ? "terminal-tab--active" : ""}`}
                key={group.id}
                onClick={() => update((current) => ({
                  ...current,
                  activeGroupId: isMobile
                    ? current.groups.find((candidate) => candidate.terminalIds.includes(terminal?.terminalId ?? ""))?.id
                    : group.id,
                  activeTerminalId: terminal?.terminalId,
                }))}
              >
                <span className={`terminal-status terminal-status--${terminal?.status ?? "interrupted"}`} />
                {terminal?.label ?? `Group ${index + 1}`}
                {group.terminalIds.length > 1 && <small>{group.terminalIds.length}</small>}
              </button>
            );
          })}
        </div>
        <span className={`terminal-connection terminal-connection--${connection}`}>{connection}</span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="New terminal tab" onClick={() => void openTab()}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
        </Button>
        {!isMobile && (
          <>
            <Button type="button" variant="ghost" size="icon-sm" disabled={!activeGroup || activeGroup.terminalIds.length >= MAX_VISIBLE_PANES} aria-label="Split terminal horizontally" onClick={() => void split("horizontal")}>
              <HugeiconsIcon icon={DragDropHorizontalIcon} strokeWidth={2} />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" disabled={!activeGroup || activeGroup.terminalIds.length >= MAX_VISIBLE_PANES} aria-label="Split terminal vertically" onClick={() => void split("vertical")}>
              <HugeiconsIcon icon={DragDropVerticalIcon} strokeWidth={2} />
            </Button>
          </>
        )}
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Hide terminal surface" onClick={() => setBottomVisible(false)}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </header>

      {terminals.length === 0 ? (
        <div className="terminal-empty">
          <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={1.7} />
          <strong>No project terminals</strong>
          <p>Start a shell at this workspace’s trusted root.</p>
          <Button type="button" size="sm" onClick={() => void openTab()}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            New terminal
          </Button>
        </div>
      ) : (
        <div className={`terminal-group terminal-group--${isMobile ? "mobile" : activeGroup?.direction ?? "horizontal"}`}>
          {visibleIds.map((terminalId) => {
            const terminal = byId.get(terminalId);
            return terminal ? (
              <TerminalPane
                key={terminalId}
                terminal={terminal}
                onActivate={() => update((current) => ({ ...current, activeTerminalId: terminalId }))}
                onClose={() => void closeTerminal(terminalId)}
              />
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}

export { reconcileUi as reconcileTerminalUiState };
