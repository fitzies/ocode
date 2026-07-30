import type { ProjectGitCheck, ProjectGitPullRequest, ProjectGitStatus } from "@anvil/protocol";
import {
  Alert02Icon,
  BotIcon,
  CheckmarkCircle02Icon,
  Clock03Icon,
  CloudUploadIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitCommitIcon,
  GithubIcon,
  Loading03Icon,
  RefreshIcon,
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
  if (!check.startedAt) return undefined;
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
  if (check.state === "passed") return duration(check) ?? "Passed";
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
        {check.workflow && check.workflow !== check.name && (
          <span className="block truncate text-[0.625rem] text-muted-foreground">{check.workflow}</span>
        )}
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
  const agents = checks.filter((check) => check.kind === "agent");
  const delivery = checks.filter((check) => check.kind !== "agent");
  const summary = projectGitCheckSummary(checks);

  return (
    <>
      <div className="px-4 py-3">
        <div className="mb-1.5 flex items-center justify-between">
          <strong className="text-[0.625rem] font-semibold uppercase tracking-[0.1em]">Checks & deployments</strong>
          <span className="font-mono text-[0.625rem] text-muted-foreground">{summary.passed} / {summary.total}</span>
        </div>
        {delivery.length > 0 ? delivery.map((check, index) => <CheckRow key={`${check.name}-${index}`} check={check} />) : (
          <p className="border-t border-border/70 py-2 text-[0.6875rem] text-muted-foreground">No checks have been reported.</p>
        )}
      </div>
      {agents.length > 0 && (
        <div className="mx-4 mb-3 rounded-lg border border-[color-mix(in_oklab,var(--status-info)_30%,var(--border))] bg-[color-mix(in_oklab,var(--status-info)_7%,transparent)] px-3 py-2.5">
          <div className="mb-1 flex items-center gap-1.5 text-[0.6875rem] font-medium text-[var(--status-info)]">
            <HugeiconsIcon icon={BotIcon} strokeWidth={2} className="size-3.5" /> Agents
          </div>
          {agents.map((check, index) => <CheckRow key={`${check.name}-${index}`} check={check} />)}
        </div>
      )}
    </>
  );
}

export function ProjectGitStatusPanel({
  projectName,
  status,
  refreshing,
  gitActionLabel,
  gitActionBusy = false,
  onGitAction,
  onRefresh,
}: {
  projectName: string;
  status: ProjectGitStatus;
  refreshing: boolean;
  gitActionLabel?: string;
  gitActionBusy?: boolean;
  onGitAction?: () => void;
  onRefresh: () => void;
}) {
  const pullRequest = status.github?.pullRequest;
  const remoteLabel = status.remote?.provider === "github" && status.remote.owner && status.remote.repository
    ? `${status.remote.owner}/${status.remote.repository}`
    : status.remote?.name ?? "Local repository";
  const branchDestination = pullRequest?.baseBranch ?? status.upstream;

  return (
    <div className="repository-status-panel">
      <div className="flex items-start justify-between gap-3 px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            {status.remote?.provider === "github"
              ? <HugeiconsIcon icon={GithubIcon} strokeWidth={1.8} className="size-3.5 text-muted-foreground" />
              : <HugeiconsIcon icon={GitBranchIcon} strokeWidth={1.8} className="size-3.5 text-muted-foreground" />}
            <span className="truncate">{projectName}</span>
          </div>
          <div className="mt-1 truncate font-mono text-[0.625rem] text-muted-foreground">
            {status.branch ?? "No branch"}{branchDestination ? ` → ${branchDestination}` : ""}
          </div>
        </div>
        {status.remote?.webUrl ? (
          <a className="inline-flex items-center gap-1 text-[0.625rem] text-muted-foreground hover:text-foreground" href={status.remote.webUrl} target="_blank" rel="noreferrer">
            {remoteLabel}<HugeiconsIcon icon={ExternalLinkIcon} strokeWidth={2} className="size-3" />
          </a>
        ) : <span className="text-[0.625rem] text-muted-foreground">{remoteLabel}</span>}
      </div>

      {pullRequest && (
        <div className="border-y border-border bg-muted/20 px-4 py-3">
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

      {!pullRequest && status.remote?.provider === "github" && !status.remoteStatusError && (
        <div className="border-y border-border bg-muted/20 px-4 py-2.5 text-[0.6875rem] text-muted-foreground">No pull request for this branch.</div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-4 py-3">
        <div>
          <strong className="text-[0.625rem] font-semibold uppercase tracking-[0.1em]">Local</strong>
          <p className="mt-1 text-[0.6875rem] text-muted-foreground">
            {status.changedFiles > 0
              ? `${status.changedFiles} changed ${status.changedFiles === 1 ? "file" : "files"}`
              : "Working tree clean"}
            {status.ahead > 0 ? ` · ${status.ahead} ahead` : ""}
            {(status.behind ?? 0) > 0 ? ` · ${status.behind} behind` : ""}
          </p>
          {status.lastCommit && <p className="mt-1 truncate font-mono text-[0.5625rem] text-muted-foreground">{status.lastCommit.shortHash} · {status.lastCommit.subject}</p>}
        </div>
        {(status.additions > 0 || status.deletions > 0) && (
          <div className="self-center font-mono text-[0.6875rem]"><span className="text-[var(--green)]">+{status.additions}</span>&nbsp; <span className="text-[var(--red)]">−{status.deletions}</span></div>
        )}
      </div>

      {(status.reason || status.statusError) && status.repositoryState !== "no-remote" && status.repositoryState !== "not-a-repository" && (
        <div className="px-4 pb-3">
          <Alert variant="destructive"><HugeiconsIcon icon={Alert02Icon} strokeWidth={2} /><AlertTitle>Repository needs attention</AlertTitle><AlertDescription>{status.statusError ?? status.reason}</AlertDescription></Alert>
        </div>
      )}

      {status.remoteStatusError && (
        <div className="px-4 pb-3">
          <Alert><HugeiconsIcon icon={CloudUploadIcon} strokeWidth={2} /><AlertTitle>Remote status unavailable</AlertTitle><AlertDescription>{status.remoteStatusError}</AlertDescription></Alert>
        </div>
      )}

      {pullRequest && <><Separator /><Checks checks={pullRequest.checks} /></>}

      <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-[0.625rem] text-muted-foreground">
        <span>Updated {relativeTime(status.statusUpdatedAt)}</span>
        <div className="flex items-center gap-1">
          {onGitAction && gitActionLabel && (
            <Button variant="ghost" size="xs" className="bg-transparent" onClick={onGitAction} disabled={gitActionBusy} aria-label={gitActionLabel}>
              <HugeiconsIcon icon={gitActionBusy ? Loading03Icon : GitCommitIcon} strokeWidth={2} className={cn(gitActionBusy && "animate-spin")} />
              {gitActionLabel}
            </Button>
          )}
          {pullRequest && (
            <Button asChild variant="ghost" size="xs"><a href={pullRequest.url} target="_blank" rel="noreferrer">View PR<HugeiconsIcon icon={ExternalLinkIcon} strokeWidth={2} /></a></Button>
          )}
          <Button variant="ghost" size="icon-xs" aria-label="Refresh repository status" onClick={onRefresh} disabled={refreshing}>
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} className={cn("size-3.5", refreshing && "animate-spin")} />
          </Button>
        </div>
      </div>
    </div>
  );
}
