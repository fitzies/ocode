import type { ShellTerminalMetadata } from "@anvil/protocol";
import {
  Add01Icon,
  ArrowReloadHorizontalIcon,
  Cancel01Icon,
  ComputerTerminal01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { terminalClient } from "@/lib/terminalClient";
import { TerminalViewport } from "./TerminalViewport";

export function reconcileActiveTerminalId(
  activeTerminalId: string | undefined,
  terminals: ShellTerminalMetadata[],
): string | undefined {
  return terminals.some((terminal) => terminal.terminalId === activeTerminalId)
    ? activeTerminalId
    : terminals[0]?.terminalId;
}

export function ProjectTerminalSurface({ projectId, isMobile: _isMobile }: { projectId: string; isMobile: boolean }) {
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
  const [activeByProject, setActiveByProject] = useState<Record<string, string | undefined>>({});

  useEffect(() => terminalClient.watchProject(projectId), [projectId]);
  useEffect(() => {
    setActiveByProject((current) => ({
      ...current,
      [projectId]: reconcileActiveTerminalId(current[projectId], terminals),
    }));
  }, [projectId, terminals]);

  const activeTerminalId = reconcileActiveTerminalId(activeByProject[projectId], terminals);
  const activeTerminal = useMemo(
    () => terminals.find((terminal) => terminal.terminalId === activeTerminalId),
    [activeTerminalId, terminals],
  );

  const openTerminal = async () => {
    try {
      const terminal = await terminalClient.open(projectId);
      setActiveByProject((current) => ({ ...current, [projectId]: terminal.terminalId }));
    } catch (error) {
      toast.error("Terminal could not be opened", { description: error instanceof Error ? error.message : String(error) });
    }
  };

  const closeTerminal = async (terminalId: string) => {
    try {
      await terminalClient.close(projectId, terminalId);
      const remaining = terminals.filter((terminal) => terminal.terminalId !== terminalId);
      setActiveByProject((current) => ({
        ...current,
        [projectId]: reconcileActiveTerminalId(current[projectId] === terminalId ? undefined : current[projectId], remaining),
      }));
    } catch (error) {
      toast.error("Terminal could not be closed", { description: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="project-terminal-surface">
      <header className="terminal-toolbar">
        <div className="terminal-tabs" role="tablist" aria-label="Project terminals">
          {terminals.map((terminal) => {
            const active = terminal.terminalId === activeTerminalId;
            return (
              <div className={`terminal-tab ${active ? "terminal-tab--active" : ""}`} key={terminal.terminalId}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={terminal.label}
                  onClick={() => setActiveByProject((current) => ({ ...current, [projectId]: terminal.terminalId }))}
                >
                  <span className={`terminal-status terminal-status--${terminal.status}`} aria-hidden="true" />
                  <span>{terminal.label}</span>
                </button>
                <button className="terminal-tab-close" type="button" aria-label={`Close ${terminal.label}`} onClick={() => void closeTerminal(terminal.terminalId)}>
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                </button>
              </div>
            );
          })}
        </div>
        {connection !== "connected" && <span className={`terminal-connection terminal-connection--${connection}`} role="status">{connection}</span>}
        {activeTerminal && activeTerminal.status !== "running" && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Restart ${activeTerminal.label}`}
            onClick={() => void terminalClient.restart(projectId, activeTerminal.terminalId).catch((error) => toast.error(error.message))}
          >
            <HugeiconsIcon icon={ArrowReloadHorizontalIcon} strokeWidth={2} />
          </Button>
        )}
        <Button type="button" variant="ghost" size="icon-sm" aria-label="New terminal" onClick={() => void openTerminal()}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
        </Button>
      </header>

      {activeTerminal ? (
        <section className="terminal-pane" aria-label={activeTerminal.label}>
          <TerminalViewport key={activeTerminal.terminalId} projectId={projectId} terminalId={activeTerminal.terminalId} />
        </section>
      ) : (
        <div className="terminal-empty">
          <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={1.7} />
          <strong>No terminals</strong>
          <p>Use the plus button to start a shell at this project’s root.</p>
        </div>
      )}
    </div>
  );
}
