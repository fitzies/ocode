import type { ProjectGitStatus } from "@anvil/protocol";
import {
  GitBranchIcon,
  GitPullRequestIcon,
  LinkSquare02Icon,
  RepairIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  commitAndPushProject,
  generateProjectCommitMessage,
  getProjectGitStatus,
  ProjectGitRequestError,
} from "@/lib/projectGit";
import { cn } from "@/lib/utils";
import { ProjectGitConnectDialog } from "./ProjectGitConnectDialog";
import { projectGitCheckSummary, projectGitPresentation } from "./projectGitPresentation";
import { ProjectGitStatusPanel } from "./ProjectGitStatusPanel";

type GitPhase = "idle" | "generating" | "committing" | "pushing";

export function ProjectGitAction({
  projectId,
  projectName,
  sessionId,
  onComplete,
}: {
  projectId: string;
  projectName: string;
  sessionId?: string;
  onComplete?: () => void;
}) {
  const [status, setStatus] = useState<ProjectGitStatus>();
  const [phase, setPhase] = useState<GitPhase>("idle");
  const [statusOpen, setStatusOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const operationRef = useRef(false);
  const statusRequestRef = useRef(false);
  const isMobile = useIsMobile();

  const refresh = useCallback(async (signal?: AbortSignal, visible = false) => {
    if (statusRequestRef.current) return;
    statusRequestRef.current = true;
    if (visible) setRefreshing(true);
    try {
      const next = await getProjectGitStatus(projectId, signal);
      if (!signal?.aborted) setStatus(next);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError") && !signal?.aborted && visible) {
        toast.error("Repository status unavailable", { description: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      statusRequestRef.current = false;
      if (!signal?.aborted && visible) setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    setStatus(undefined);
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      if (!operationRef.current) void refresh(controller.signal);
    }, statusOpen ? 10_000 : 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh, statusOpen]);

  if (!status) return null;

  const presentation = projectGitPresentation(status);
  const pullRequest = status.github?.pullRequest;
  const checkSummary = pullRequest ? projectGitCheckSummary(pullRequest.checks) : undefined;
  const busy = phase !== "idle";
  const hasInlineAction = presentation.action === "connect" || presentation.action === "repair";

  const run = async () => {
    if (operationRef.current || status.action === "unavailable" || status.action === "up-to-date") return;
    operationRef.current = true;
    try {
      if (status.action === "commit-and-push") {
        setPhase("generating");
        const generated = await generateProjectCommitMessage(projectId, sessionId);
        setPhase("committing");
        const result = await commitAndPushProject(projectId, {
          message: generated.message,
          changeFingerprint: generated.changeFingerprint,
        });
        toast.success("Committed and pushed", { description: `${result.commit} · ${result.message ?? generated.message}` });
      } else {
        setPhase("pushing");
        const result = await commitAndPushProject(projectId, {});
        toast.success("Branch pushed", { description: `${result.branch} · ${result.commit}` });
      }
      onComplete?.();
    } catch (error) {
      if (error instanceof ProjectGitRequestError && error.committed) {
        toast.error("Committed, but push failed", {
          description: error.commitMessage
            ? `${error.commit ?? "Commit created"} · ${error.commitMessage}. ${error.message}`
            : error.message,
          duration: 10_000,
        });
        onComplete?.();
      } else {
        toast.error("Git action failed", { description: error instanceof Error ? error.message : String(error), duration: 10_000 });
      }
    } finally {
      operationRef.current = false;
      setPhase("idle");
      void refresh();
    }
  };

  const actionLabel = phase === "generating"
    ? "Generating…"
    : phase === "committing"
      ? "Committing & pushing…"
      : phase === "pushing"
        ? "Pushing…"
        : presentation.actionLabel;

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "repository-status-trigger max-w-[230px] border-0 bg-transparent font-normal tabular-nums shadow-none",
        hasInlineAction && "repository-status-trigger--joined",
      )}
      aria-label={`Repository status: ${presentation.label}`}
    >
      <HugeiconsIcon
        icon={pullRequest ? GitPullRequestIcon : status.repositoryState === "not-a-repository" ? LinkSquare02Icon : GitBranchIcon}
        strokeWidth={2}
        data-icon="inline-start"
      />
      <span className="repository-status-trigger-label truncate">{presentation.label}</span>
      {checkSummary && checkSummary.total > 0 && <span className="repository-status-count font-mono text-[0.5625rem] text-muted-foreground">{checkSummary.passed}/{checkSummary.total}</span>}
      {!pullRequest && (status.additions > 0 || status.deletions > 0) && (
        <span className="repository-status-trigger-diff font-mono text-[0.5625rem]"><span className="text-[var(--green)]">+{status.additions}</span>&nbsp;<span className="text-[var(--red)]">−{status.deletions}</span></span>
      )}
    </Button>
  );

  const panel = (
    <ProjectGitStatusPanel
      projectName={projectName}
      status={status}
      refreshing={refreshing}
      gitActionLabel={presentation.action === "commit" || presentation.action === "push" ? actionLabel : undefined}
      gitActionBusy={busy}
      onGitAction={presentation.action === "commit" || presentation.action === "push" ? () => void run() : undefined}
      onRefresh={() => void refresh(undefined, true)}
    />
  );

  return (
    <>
      <div className="repository-header-control">
        {isMobile ? (
          <Sheet open={statusOpen} onOpenChange={setStatusOpen}>
            <SheetTrigger asChild>{trigger}</SheetTrigger>
            <SheetContent side="bottom" className="max-h-[82dvh] overflow-y-auto rounded-t-xl p-0">
              <SheetHeader className="sr-only"><SheetTitle>Repository status</SheetTitle><SheetDescription>Local Git, pull request, checks, deployments, and agent activity.</SheetDescription></SheetHeader>
              {panel}
            </SheetContent>
          </Sheet>
        ) : (
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            <PopoverContent align="end" sideOffset={8} className="w-[400px] max-w-[calc(100vw-1rem)] gap-0 overflow-hidden p-0">
              {panel}
            </PopoverContent>
          </Popover>
        )}

        {presentation.action === "connect" && (
          <Button type="button" size="sm" className="repository-inline-action" aria-label={presentation.actionLabel ?? "Connect"} onClick={() => setConnectOpen(true)}>
            <span className="repository-action-label">{presentation.actionLabel ?? "Connect"}</span>
          </Button>
        )}
        {presentation.action === "repair" && (
          <Button type="button" variant="outline" size="sm" className="repository-inline-action" aria-label={presentation.actionLabel} onClick={() => setStatusOpen(true)}>
            <HugeiconsIcon icon={RepairIcon} strokeWidth={2} data-icon="inline-start" />
            <span className="repository-action-label">{presentation.actionLabel}</span>
          </Button>
        )}
      </div>

      <ProjectGitConnectDialog
        open={connectOpen}
        projectId={projectId}
        projectName={projectName}
        status={status}
        onOpenChange={setConnectOpen}
        onConnected={(next) => {
          setStatus(next);
          toast.success("Repository connected", { description: next.remote?.webUrl ?? `${next.remote?.name ?? "origin"} is ready` });
        }}
      />
    </>
  );
}
