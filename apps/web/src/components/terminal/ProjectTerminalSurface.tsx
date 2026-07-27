import type { ShellTerminalMetadata } from "@anvil/protocol";
import {
  Add01Icon,
  ArrowReloadHorizontalIcon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
  const projectLoaded = useSyncExternalStore(
    terminalClient.subscribe,
    () => terminalClient.projectLoaded(projectId),
    () => terminalClient.projectLoaded(projectId),
  );
  const [activeByProject, setActiveByProject] = useState<Record<string, string | undefined>>({});
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [closingTerminalIds, setClosingTerminalIds] = useState<ReadonlySet<string>>(() => new Set());
  const openingRef = useRef(false);
  const closingTerminalIdsRef = useRef(new Set<string>());
  const userSelectionVersionRef = useRef(0);
  const autoCreateRef = useRef({ projectId, attempted: false });

  useEffect(() => terminalClient.watchProject(projectId), [projectId]);
  const visibleTerminals = useMemo(
    () => terminals.filter((terminal) => !closingTerminalIds.has(terminal.terminalId)),
    [closingTerminalIds, terminals],
  );

  useEffect(() => {
    setActiveByProject((current) => ({
      ...current,
      [projectId]: reconcileActiveTerminalId(current[projectId], visibleTerminals),
    }));
  }, [projectId, visibleTerminals]);

  const activeTerminalId = reconcileActiveTerminalId(activeByProject[projectId], visibleTerminals);
  const activeTerminal = useMemo(
    () => visibleTerminals.find((terminal) => terminal.terminalId === activeTerminalId),
    [activeTerminalId, visibleTerminals],
  );

  const openTerminal = useCallback(async () => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setOpenFailed(false);
    try {
      const terminal = await terminalClient.open(projectId);
      setActiveByProject((current) => ({ ...current, [projectId]: terminal.terminalId }));
    } catch (error) {
      setOpenFailed(true);
      toast.error("Terminal could not be opened", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (autoCreateRef.current.projectId !== projectId) {
      autoCreateRef.current = { projectId, attempted: false };
    }
    if (terminals.length > 0) {
      autoCreateRef.current.attempted = false;
      return;
    }
    if (
      !projectLoaded ||
      !terminalClient.projectLoaded(projectId) ||
      autoCreateRef.current.attempted ||
      openingRef.current
    ) return;
    autoCreateRef.current.attempted = true;
    void openTerminal();
  }, [openTerminal, projectId, projectLoaded, terminals.length]);

  const closeTerminal = async (terminalId: string) => {
    if (closingTerminalIdsRef.current.has(terminalId)) return;

    const activeTerminalIdBeforeClose = activeTerminalId;
    const userSelectionVersionBeforeClose = userSelectionVersionRef.current;
    closingTerminalIdsRef.current.add(terminalId);
    setClosingTerminalIds(new Set(closingTerminalIdsRef.current));
    const remaining = terminals.filter((terminal) => !closingTerminalIdsRef.current.has(terminal.terminalId));
    const optimisticActiveTerminalId = reconcileActiveTerminalId(
      activeTerminalIdBeforeClose === terminalId ? undefined : activeTerminalIdBeforeClose,
      remaining,
    );
    setActiveByProject((current) => ({
      ...current,
      [projectId]: optimisticActiveTerminalId,
    }));

    try {
      await terminalClient.close(projectId, terminalId);
    } catch (error) {
      if (activeTerminalIdBeforeClose === terminalId) {
        setActiveByProject((current) => (
          userSelectionVersionRef.current === userSelectionVersionBeforeClose &&
          current[projectId] === optimisticActiveTerminalId
            ? { ...current, [projectId]: terminalId }
            : current
        ));
      }
      toast.error("Terminal could not be closed", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      closingTerminalIdsRef.current.delete(terminalId);
      setClosingTerminalIds(new Set(closingTerminalIdsRef.current));
    }
  };

  return (
    <div className="project-terminal-surface">
      <header className="terminal-toolbar">
        <div className="terminal-tabs" role="tablist" aria-label="Project terminals">
          {visibleTerminals.map((terminal) => {
            const active = terminal.terminalId === activeTerminalId;
            return (
              <div className={`terminal-tab ${active ? "terminal-tab--active" : ""}`} key={terminal.terminalId}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={terminal.label}
                  onClick={() => {
                    userSelectionVersionRef.current += 1;
                    setActiveByProject((current) => ({ ...current, [projectId]: terminal.terminalId }));
                  }}
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
        <div className="terminal-starting" role="status" aria-live="polite">
          {!openFailed && <span className="terminal-starting-indicator" aria-hidden="true" />}
          <span>
            {openFailed
              ? "Terminal unavailable. Use + to retry."
              : closingTerminalIds.size > 0
                ? "Closing terminal…"
                : opening
                  ? "Starting terminal…"
                  : "Loading terminals…"}
          </span>
        </div>
      )}
    </div>
  );
}
