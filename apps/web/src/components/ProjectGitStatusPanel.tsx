import type { ProjectGitCheck, ProjectGitPullRequest, ProjectGitStatus } from "@anvil/protocol";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Clock03Icon,
  CloudUploadIcon,
  ExternalLinkIcon,
  GitCommitIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { projectGitCheckSummary } from "./projectGitPresentation";

function relativeTime(value?: string): string {
  if (!value) return "just now";
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 30_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.max(1, Math.round(elapsed / 60_000))}m ago`;
  if (elapsed < 86_400_000) return `${Math.round(elapsed / 3_600_000)}h ago`;
  return `${Math.round(elapsed / 86_400_000)}d ago`;
}

function duration(check: ProjectGitCheck): string | undefined {
  if (!check.startedAt || (!check.completedAt && check.state !== "running" && check.state !== "queued")) return undefined;
  const start = new Date(check.startedAt).getTime();
  const end = check.completedAt ? new Date(check.completedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const seconds = Math.round((end - start) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function reviewLabel(pullRequest: ProjectGitPullRequest): string {
  if (pullRequest.reviewDecision === "approved") return "Approved";
  if (pullRequest.reviewDecision === "changes-requested") return "Changes requested";
  if (pullRequest.reviewDecision === "review-required") return "Review required";
  return "Review pending";
}

function mergeLabel(pullRequest: ProjectGitPullRequest): string {
  if (pullRequest.mergeable === "mergeable") return "Mergeable";
  if (pullRequest.mergeable === "conflicting") return "Conflicts";
  return "Mergeability unknown";
}

function checkIcon(check: ProjectGitCheck) {
  if (check.state === "passed") return <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2} className="size-3.5 text-[var(--green)]" />;
  if (check.state === "failed") return <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-3.5 text-[var(--red)]" />;
  if (check.state === "running") return <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="size-3.5 animate-spin text-[var(--status-info)]" />;
  if (check.state === "queued") return <HugeiconsIcon icon={Clock03Icon} strokeWidth={2} className="size-3.5 text-[var(--amber)]" />;
  return <span className="mx-1 block size-1.5 rounded-full bg-muted-foreground/60" />;
}

function stateLabel(check: ProjectGitCheck): string {
  if (check.state === "running") return "Running…";
  if (check.state === "queued") return "Queued";
  if (check.state === "passed") return check.kind === "deployment" ? "Live" : duration(check) ?? "Passed";
  if (check.state === "failed") return "Failed";
  if (check.state === "cancelled") return "Cancelled";
  if (check.state === "skipped") return "Skipped";
  if (check.state === "neutral") return "Complete";
  return "Unknown";
}

function CheckRow({ check }: { check: ProjectGitCheck }) {
  const content = (
    <>
      <span className="flex size-4 items-center justify-center">{checkIcon(check)}</span>
      <span className="min-w-0">
        <span className="block truncate text-foreground">{check.name}</span>
        {(check.signalCount && check.signalCount > 1) || (check.workflow && check.workflow !== check.name) ? (
          <span className="block truncate text-[0.625rem] text-muted-foreground">
            {check.signalCount && check.signalCount > 1 ? `${check.signalCount} GitHub signals combined` : ""}
            {check.signalCount && check.signalCount > 1 && check.workflow && check.workflow !== check.name ? " · " : ""}
            {check.workflow && check.workflow !== check.name ? check.workflow : ""}
          </span>
        ) : null}
      </span>
      <span className={cn(
        "whitespace-nowrap text-[0.625rem] text-muted-foreground",
        check.state === "running" && "text-[var(--status-info)]",
        check.state === "failed" && "text-[var(--red)]",
      )}>{stateLabel(check)}</span>
    </>
  );

  return check.url ? (
    <a className="grid min-h-9 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 border-t border-border/70 py-1.5 hover:text-foreground" href={check.url} target="_blank" rel="noreferrer">
      {content}
    </a>
  ) : (
    <div className="grid min-h-9 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 border-t border-border/70 py-1.5">
      {content}
    </div>
  );
}

function Checks({ checks }: { checks: ProjectGitCheck[] }) {
  const ci = checks.filter((check) => check.kind === "check");
  const summary = projectGitCheckSummary(ci);
  const label = summary.failed > 0
    ? `${summary.failed} ${summary.failed === 1 ? "check" : "checks"} failed`
    : summary.running > 0
      ? `${summary.running} ${summary.running === 1 ? "check" : "checks"} running`
      : ci.length > 0
        ? `${summary.passed} of ${summary.total} checks passed`
        : "No CI checks";

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <strong className="text-[0.625rem] font-semibold uppercase tracking-[0.1em]">CI checks</strong>
        <span className={cn(
          "text-[0.625rem] text-muted-foreground",
          summary.failed > 0 && "text-[var(--red)]",
          summary.running > 0 && "text-[var(--status-info)]",
          ci.length > 0 && summary.failed === 0 && summary.running === 0 && "text-[var(--green)]",
        )}>{label}</span>
      </div>
      {ci.length > 0 ? (
        <div className="mt-1.5">{ci.map((check, index) => <CheckRow key={`${check.name}-${index}`} check={check} />)}</div>
      ) : (
        <p className="mt-2 border-t border-border/70 pt-2 text-[0.625rem] text-muted-foreground">No checks reported for this commit.</p>
      )}
    </div>
  );
}

export function ProjectGitStatusPanel({
  status,
  gitActionLabel,
  gitActionBusy = false,
  onGitAction,
}: {
  status: ProjectGitStatus;
  gitActionLabel?: string;
  gitActionBusy?: boolean;
  onGitAction?: () => void;
}) {
  const pullRequest = status.github?.pullRequest;
  const commit = status.github?.commit;
  const checks = commit ? commit.checks : pullRequest?.checks ?? [];

  return (
    <div className="min-w-0 text-popover-foreground">
      {commit && (
        <div className="px-4 py-3 pr-12">
          <div className="mb-1.5 text-[0.5625rem] font-medium uppercase tracking-[0.1em] text-muted-foreground">Latest commit</div>
          <div className="flex items-start justify-between gap-3">
            <strong className="min-w-0 truncate text-[0.75rem] font-medium text-foreground">{commit.subject}</strong>
            <a className="shrink-0 font-mono text-[0.625rem] text-[var(--status-info)] hover:underline" href={commit.url} target="_blank" rel="noreferrer">{commit.shortHash}</a>
          </div>
        </div>
      )}

      {pullRequest && (
        <div className={cn("border-b border-border bg-muted/20 px-4 py-3", !commit && "border-t")}>
          <div className="flex items-start justify-between gap-3">
            <a className="min-w-0 truncate font-medium text-foreground hover:underline" href={pullRequest.url} target="_blank" rel="noreferrer">
              PR #{pullRequest.number} · {pullRequest.title}
            </a>
            <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[0.5625rem] capitalize">{pullRequest.isDraft ? "Draft" : pullRequest.state}</Badge>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[0.625rem] text-muted-foreground">
            <span>{reviewLabel(pullRequest)}</span><span>{mergeLabel(pullRequest)}</span><span>Updated {relativeTime(pullRequest.updatedAt)}</span>
          </div>
        </div>
      )}

      <div className={cn("flex items-end justify-between gap-3 px-4 py-3", commit ? "border-t border-border" : "pr-12")}>
        <div>
          <div className="mb-1.5 text-[0.5625rem] font-medium uppercase tracking-[0.1em] text-muted-foreground">Local changes</div>
          <span className="text-[0.6875rem] text-foreground">{status.changedFiles > 0 ? `${status.changedFiles} changed ${status.changedFiles === 1 ? "file" : "files"}` : "Working tree clean"}</span>
        </div>
        {(status.additions > 0 || status.deletions > 0) && (
          <span className="shrink-0 font-mono text-[0.6875rem]"><span className="text-[var(--green)]">+{status.additions}</span>&nbsp;&nbsp;<span className="text-[var(--red)]">−{status.deletions}</span></span>
        )}
      </div>

      {(status.reason || status.statusError) && status.repositoryState !== "no-remote" && status.repositoryState !== "not-a-repository" && (
        <div className="px-4 pb-3">
          <Alert variant="destructive"><HugeiconsIcon icon={Alert02Icon} strokeWidth={2} /><AlertTitle>Repository needs attention</AlertTitle><AlertDescription>{status.statusError ?? status.reason}</AlertDescription></Alert>
        </div>
      )}

      {status.remoteStatusError && (
        <div className="px-4 pb-3">
          <Alert><HugeiconsIcon icon={CloudUploadIcon} strokeWidth={2} /><AlertTitle>{commit && !commit.complete ? "Some delivery status unavailable" : "Remote status unavailable"}</AlertTitle><AlertDescription>{status.remoteStatusError}</AlertDescription></Alert>
        </div>
      )}

      {(commit || pullRequest) && checks.some((check) => check.kind === "check") && <><Separator /><Checks checks={checks} /></>}

      <div className="flex items-center justify-end border-t border-border px-3 py-2">
        <div className="flex items-center gap-1">
          {onGitAction && gitActionLabel && (
            <Button variant="ghost" size="xs" className="bg-transparent" onClick={onGitAction} disabled={gitActionBusy} aria-label={gitActionLabel}>
              <HugeiconsIcon icon={gitActionBusy ? Loading03Icon : GitCommitIcon} strokeWidth={2} className={cn(gitActionBusy && "animate-spin")} />
              {gitActionLabel}
            </Button>
          )}
          {pullRequest && (
            <Button asChild variant="ghost" size="xs"><a href={pullRequest.url} target="_blank" rel="noreferrer">PR<HugeiconsIcon icon={ExternalLinkIcon} strokeWidth={2} /></a></Button>
          )}
        </div>
      </div>
    </div>
  );
}
