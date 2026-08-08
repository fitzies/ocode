import type { ProjectGitStatus } from "@anvil/protocol";
import {
  ArrowDown01Icon,
  GitBranchIcon,
  GitPullRequestIcon,
  GithubIcon,
  LinkSquare02Icon,
  Loading03Icon,
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
import { ProjectGitConnectDialog } from "./ProjectGitConnectDialog";
import { projectGitCheckSummary, projectGitDeliveryCompletion, projectGitPresentation } from "./projectGitPresentation";
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
  const lastPushAtRef = useRef(0);
  const deliveryObservationRef = useRef<{ hash: string; awaiting: boolean } | undefined>(undefined);
  const notifiedDeliveryRef = useRef<string | undefined>(undefined);
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

  const polledChecks = status?.github?.commit?.checks ?? status?.github?.pullRequest?.checks ?? [];
  const hasActiveDelivery = polledChecks.some((check) => check.state === "queued" || check.state === "running");
  const commitAge = status?.github?.commit && status.lastCommit?.hash === status.github.commit.hash
    ? Date.now() - new Date(status.lastCommit.authoredAt).getTime()
    : Number.POSITIVE_INFINITY;
  const recentlyPushed = Date.now() - lastPushAtRef.current < 120_000;
  const awaitingInitialReports = Boolean(status?.github?.commit && polledChecks.length === 0 && (recentlyPushed || commitAge < 120_000));
  const pollingInterval = hasActiveDelivery ? 10_000 : awaitingInitialReports ? 15_000 : statusOpen ? 30_000 : 60_000;

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      if (!operationRef.current) void refresh(controller.signal);
    }, pollingInterval);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [pollingInterval, refresh]);

  useEffect(() => {
    const commit = status?.github?.commit;
    if (!commit) {
      deliveryObservationRef.current = undefined;
      return;
    }
    const completion = projectGitDeliveryCompletion(commit.checks);
    const awaiting = !commit.complete || !completion.terminal;
    const previous = deliveryObservationRef.current;
    const recentlyPushed = Date.now() - lastPushAtRef.current < 120_000;
    const shouldNotify = completion.terminal &&
      notifiedDeliveryRef.current !== commit.hash &&
      ((previous?.hash === commit.hash && previous.awaiting) || recentlyPushed);
    deliveryObservationRef.current = { hash: commit.hash, awaiting };
    if (!shouldNotify) return;
    notifiedDeliveryRef.current = commit.hash;
    const title = completion.hasIssues ? "Delivery finished with issues" : "Delivery complete";
    const description = `${completion.passed}/${completion.total} checks passed · ${projectName}`;
    if (document.visibilityState !== "visible" || !document.hasFocus()) {
      if ("Notification" in window && Notification.permission === "granted") {
        const notification = new Notification(title, {
          body: description,
          icon: "/favicon.svg",
          tag: `ocode-delivery-${projectId}-${commit.hash}`,
        });
        notification.onclick = () => {
          window.focus();
          setStatusOpen(true);
          notification.close();
        };
      }
      return;
    }
    const options = {
      id: `delivery-${projectId}-${commit.hash}`,
      description,
      duration: 8_000,
      action: { label: "View", onClick: () => setStatusOpen(true) },
    };
    if (completion.hasIssues) toast.error(title, options);
    else toast.success(title, options);
  }, [projectId, projectName, status?.github?.commit]);

  if (!status) return null;

  const presentation = projectGitPresentation(status);
  const pullRequest = status.github?.pullRequest;
  const commit = status.github?.commit;
  const deliveryChecks = commit ? commit.checks : pullRequest?.checks;
  const checkSummary = deliveryChecks ? projectGitCheckSummary(deliveryChecks) : undefined;
  const busy = phase !== "idle";

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
      lastPushAtRef.current = Date.now();
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
  const [primaryStatusLabel, ...secondaryStatusParts] = presentation.label.split(" · ");
  const secondaryStatusLabel = secondaryStatusParts.join(" · ");
  const connectLabel = presentation.actionLabel === "Choose remote" ? "Choose remote" : "Connect repository";

  const trigger = (
    <Button
      type="button"
      variant="outline"
      className="repository-header-button max-w-52 min-w-0 font-normal tabular-nums max-sm:max-w-32"
      aria-label={`Repository status: ${presentation.label}`}
    >
      <HugeiconsIcon
        icon={presentation.busy ? Loading03Icon : pullRequest ? GitPullRequestIcon : status.remote?.provider === "github" ? GithubIcon : GitBranchIcon}
        strokeWidth={1.8}
        data-icon="inline-start"
        className={presentation.busy ? "animate-spin text-[var(--status-info)]" : "text-muted-foreground"}
      />
      <span className="truncate font-medium max-[420px]:hidden">{primaryStatusLabel}</span>
      {secondaryStatusLabel && <span className="truncate text-muted-foreground max-sm:hidden">· {secondaryStatusLabel}</span>}
      {checkSummary && checkSummary.total > 0 && <span className="text-[0.625rem] text-muted-foreground max-sm:hidden">{checkSummary.passed}/{checkSummary.total}</span>}
      {(!checkSummary || checkSummary.total === 0) && !pullRequest && (status.additions > 0 || status.deletions > 0) && (
        <span className="flex gap-1 font-mono text-[0.625rem] max-sm:hidden"><span className="text-[var(--green)]">+{status.additions}</span><span className="text-[var(--red)]">−{status.deletions}</span></span>
      )}
      <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} data-icon="inline-end" className="text-muted-foreground max-[420px]:hidden" />
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
      <div className="flex min-w-0 items-center">
        {presentation.action === "connect" ? (
          <Button
            type="button"
            variant="outline"
            className="repository-header-button max-w-44 min-w-0"
            aria-label={connectLabel}
            onClick={() => setConnectOpen(true)}
          >
            <HugeiconsIcon
              icon={status.repositoryState === "not-a-repository" ? GithubIcon : LinkSquare02Icon}
              strokeWidth={1.8}
              data-icon="inline-start"
              className="text-muted-foreground"
            />
            <span className="truncate max-[420px]:hidden">{connectLabel}</span>
          </Button>
        ) : isMobile ? (
          <Sheet open={statusOpen} onOpenChange={setStatusOpen}>
            <SheetTrigger asChild>{trigger}</SheetTrigger>
            <SheetContent side="bottom" className="max-h-[82dvh] overflow-y-auto rounded-t-xl p-0">
              <SheetHeader className="sr-only"><SheetTitle>Repository status</SheetTitle><SheetDescription>Local Git, commit checks, deployments, pull requests, and agent activity.</SheetDescription></SheetHeader>
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
