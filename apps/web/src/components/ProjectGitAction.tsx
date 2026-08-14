import type { ProjectGitStatus } from "@anvil/protocol";
import {
  GitBranchIcon,
  GitPullRequestIcon,
  GithubIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorkspaceSurfaces } from "@/components/workspace/WorkspaceSurfaceState";
import { getProjectGitStatus } from "@/lib/projectGit";
import { projectGitDeliveryCompletion, projectGitPresentation } from "./projectGitPresentation";

export function ProjectGitAction({
  projectId,
  projectName,
  refreshGeneration = 0,
}: {
  projectId: string;
  projectName: string;
  refreshGeneration?: number;
}) {
  const { state: surfaceState, setRightVisible, openSidePage } = useWorkspaceSurfaces();
  const [status, setStatus] = useState<ProjectGitStatus>();
  const gitActive = surfaceState.rightVisible && surfaceState.sidePage === "git";
  const deliveryObservationRef = useRef<{ hash: string; awaiting: boolean } | undefined>(undefined);
  const notifiedDeliveryRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await getProjectGitStatus(projectId, signal);
      if (!signal?.aborted) setStatus(next);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError") && !signal?.aborted) {
        console.warn("Repository status unavailable", error);
      }
    }
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh, refreshGeneration]);

  const polledChecks = status?.github?.commit?.checks ?? status?.github?.pullRequest?.checks ?? [];
  const hasActiveDelivery = polledChecks.some((check) => check.state === "queued" || check.state === "running");
  const commitAge = status?.github?.commit && status.lastCommit?.hash === status.github.commit.hash
    ? Date.now() - new Date(status.lastCommit.authoredAt).getTime()
    : Number.POSITIVE_INFINITY;
  const awaitingInitialReports = Boolean(status?.github?.commit && polledChecks.length === 0 && commitAge < 120_000);
  const pollingInterval = hasActiveDelivery ? 10_000 : awaitingInitialReports ? 15_000 : gitActive ? 30_000 : 60_000;

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setInterval(() => void refresh(controller.signal), pollingInterval);
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
    const shouldNotify = completion.terminal &&
      notifiedDeliveryRef.current !== commit.hash &&
      previous?.hash === commit.hash && previous.awaiting;
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
          openSidePage("git");
          notification.close();
        };
      }
      return;
    }
    const options = {
      id: `delivery-${projectId}-${commit.hash}`,
      description,
      duration: 8_000,
      action: { label: "View", onClick: () => openSidePage("git") },
    };
    if (completion.hasIssues) toast.error(title, options);
    else toast.success(title, options);
  }, [openSidePage, projectId, projectName, status?.github?.commit]);

  if (!status) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Open GitHub activity"
        className="header-outline-control animate-pulse"
        onClick={() => openSidePage("git")}
      >
        <HugeiconsIcon icon={GithubIcon} strokeWidth={2} className="text-muted-foreground" />
      </Button>
    );
  }

  const presentation = projectGitPresentation(status);
  const pullRequest = status.github?.pullRequest;
  const lineChangeLabel = [
    status.additions > 0 ? `${status.additions} ${status.additions === 1 ? "addition" : "additions"}` : "",
    status.deletions > 0 ? `${status.deletions} ${status.deletions === 1 ? "deletion" : "deletions"}` : "",
  ].filter(Boolean).join(", ");
  const repositoryLabel = `Repository status: ${presentation.label}${lineChangeLabel ? `, ${lineChangeLabel}` : ""}`;

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={`header-outline-control${lineChangeLabel ? " header-outline-control--changes" : ""}`}
      aria-label={repositoryLabel}
      aria-pressed={gitActive}
      onClick={() => gitActive ? setRightVisible(false) : openSidePage("git")}
    >
      <HugeiconsIcon
        icon={presentation.busy ? Loading03Icon : pullRequest ? GitPullRequestIcon : status.remote?.provider === "github" ? GithubIcon : GitBranchIcon}
        strokeWidth={2}
        className={presentation.busy ? "animate-spin text-[var(--status-info)]" : "text-muted-foreground"}
      />
      {(status.additions > 0 || status.deletions > 0) && (
        <span className="pointer-events-none flex items-center gap-1 text-[0.625rem] leading-none tabular-nums" aria-hidden="true">
          {status.additions > 0 && <span className="text-[var(--green)]">+{status.additions}</span>}
          {status.deletions > 0 && <span className="text-[var(--red)]">−{status.deletions}</span>}
        </span>
      )}
    </Button>
  );

  return (
    <div className="flex min-w-0 items-center">
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side="bottom">{gitActive ? "Hide GitHub activity" : repositoryLabel}</TooltipContent>
      </Tooltip>
    </div>
  );
}
