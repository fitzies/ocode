import type { ProjectGitCheck, ProjectGitPullRequest, ProjectGitStatus } from "@anvil/protocol";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Clock03Icon,
  CloudUploadIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitCommitIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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

type GitPanelView = "changes" | "commits" | "checks";

function pathParts(path: string): { directory: string; name: string } {
  const separator = path.lastIndexOf("/");
  return separator < 0
    ? { directory: "", name: path }
    : { directory: path.slice(0, separator + 1), name: path.slice(separator + 1) };
}

export function ProjectGitStatusPanel({
  status,
  gitActionLabel,
  gitActionBusy = false,
  onGitAction,
  onOpenFile,
}: {
  status: ProjectGitStatus;
  gitActionLabel?: string;
  gitActionBusy?: boolean;
  onGitAction?: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const pullRequest = status.github?.pullRequest;
  const commit = status.github?.commit;
  const checks = (commit ? commit.checks : pullRequest?.checks ?? []).filter((check) => check.kind === "check");
  const commits = status.recentCommits?.length ? status.recentCommits : status.lastCommit ? [status.lastCommit] : [];
  const [view, setView] = useState<GitPanelView>(status.changedFiles > 0 ? "changes" : "commits");
  const repositoryLabel = status.remote?.provider === "github" && status.remote.owner && status.remote.repository
    ? `${status.remote.owner}/${status.remote.repository}`
    : status.upstream ?? "Local repository";

  const tabs: Array<{ id: GitPanelView; label: string; count: number }> = [
    { id: "changes", label: "Changes", count: status.changedFiles },
    { id: "commits", label: "Commits", count: commits.length },
    { id: "checks", label: "Checks", count: checks.length },
  ];

  return (
    <div className="min-w-0 text-popover-foreground">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[0.75rem] font-medium text-foreground">
            <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} className="size-3.5 text-muted-foreground" />
            <span className="truncate">{status.branch ?? "Repository"}</span>
          </div>
          <div className="mt-0.5 truncate text-[0.625rem] text-muted-foreground">{repositoryLabel}</div>
        </div>
        {onGitAction && gitActionLabel && (
          <Button size="xs" onClick={onGitAction} disabled={gitActionBusy} aria-label={gitActionLabel}>
            <HugeiconsIcon icon={gitActionBusy ? Loading03Icon : GitCommitIcon} strokeWidth={2} className={cn(gitActionBusy && "animate-spin")} />
            {gitActionLabel}
          </Button>
        )}
      </div>

      {pullRequest && (
        <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/20 px-3 py-2">
          <div className="min-w-0">
            <a className="block truncate text-[0.6875rem] font-medium text-foreground hover:underline" href={pullRequest.url} target="_blank" rel="noreferrer">
              PR #{pullRequest.number} · {pullRequest.title}
            </a>
            <div className="mt-0.5 flex gap-2 text-[0.5625rem] text-muted-foreground">
              <span>{reviewLabel(pullRequest)}</span><span>·</span><span>{mergeLabel(pullRequest)}</span>
            </div>
          </div>
          <Button asChild variant="outline" size="icon-xs">
            <a href={pullRequest.url} target="_blank" rel="noreferrer" aria-label={`Open pull request ${pullRequest.number}`}><HugeiconsIcon icon={ExternalLinkIcon} strokeWidth={2} /></a>
          </Button>
        </div>
      )}

      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5" role="tablist" aria-label="Repository activity">
        {tabs.map((tab) => (
          <Button
            type="button"
            id={`git-activity-tab-${tab.id}`}
            role="tab"
            aria-controls={`git-activity-panel-${tab.id}`}
            aria-selected={view === tab.id}
            variant={view === tab.id ? "secondary" : "ghost"}
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-[0.6875rem] font-normal"
            onClick={() => setView(tab.id)}
            key={tab.id}
          >
            {tab.label}<span className="text-muted-foreground tabular-nums">{tab.count}</span>
          </Button>
        ))}
      </div>

      {(status.reason || status.statusError) && status.repositoryState !== "no-remote" && status.repositoryState !== "not-a-repository" && (
        <div className="px-3 pt-3">
          <Alert variant="destructive"><HugeiconsIcon icon={Alert02Icon} strokeWidth={2} /><AlertTitle>Repository needs attention</AlertTitle><AlertDescription>{status.statusError ?? status.reason}</AlertDescription></Alert>
        </div>
      )}

      {status.remoteStatusError && (
        <div className="px-3 pt-3">
          <Alert><HugeiconsIcon icon={CloudUploadIcon} strokeWidth={2} /><AlertTitle>{commit && !commit.complete ? "Some delivery status unavailable" : "Remote status unavailable"}</AlertTitle><AlertDescription>{status.remoteStatusError}</AlertDescription></Alert>
        </div>
      )}

      {view === "changes" && (
        <section id="git-activity-panel-changes" role="tabpanel" aria-labelledby="git-activity-tab-changes" className="py-1.5">
          {status.files?.length ? status.files.map((file) => {
            const parts = pathParts(file.path);
            const changeTone = file.additions > 0 && file.deletions > 0
              ? "border-[var(--amber)] text-[var(--amber)]"
              : file.deletions > 0
                ? "border-[var(--red)] text-[var(--red)]"
                : "border-[var(--green)] text-[var(--green)]";
            return (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9 w-full min-w-0 justify-start gap-2 rounded-none px-3 font-normal"
                key={file.path}
                title={file.path}
                onClick={() => onOpenFile?.(file.path)}
              >
                <span className="flex min-w-0 flex-1 items-baseline text-left text-[0.75rem]">
                  {parts.directory && <span className="min-w-0 truncate text-muted-foreground">{parts.directory}</span>}
                  <span className="max-w-[62%] shrink-0 truncate text-foreground">{parts.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-[0.625rem] tabular-nums">
                  {file.additions > 0 && <span className="text-[var(--green)]">+{file.additions}</span>}
                  {file.deletions > 0 && <span className="text-[var(--red)]">−{file.deletions}</span>}
                  {file.additions === 0 && file.deletions === 0 && <span className="text-muted-foreground">binary</span>}
                  <span className={cn("flex size-3 items-center justify-center rounded-[2px] border text-[0.5rem] leading-none", changeTone)} aria-hidden="true">
                    {file.additions > 0 && file.deletions > 0 ? "·" : file.deletions > 0 ? "−" : "+"}
                  </span>
                </span>
              </Button>
            );
          }) : (
            <p className="px-3 py-6 text-center text-[0.6875rem] text-muted-foreground">Working tree clean.</p>
          )}
        </section>
      )}

      {view === "commits" && (
        <section id="git-activity-panel-commits" role="tabpanel" aria-label="Recent commits" className="py-1.5">
          {commits.map((item) => {
            const url = status.remote?.provider === "github" && status.remote.webUrl ? `${status.remote.webUrl}/commit/${item.hash}` : undefined;
            const content = (
              <>
                <HugeiconsIcon icon={GitCommitIcon} strokeWidth={2} className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-left text-[0.75rem] font-normal">{item.subject}</span>
                <span className="shrink-0 text-[0.625rem] text-muted-foreground">{item.shortHash}</span>
                <span className="w-10 shrink-0 text-right text-[0.5625rem] text-muted-foreground">{relativeTime(item.authoredAt)}</span>
              </>
            );
            return url ? (
              <Button asChild variant="ghost" size="sm" className="h-9 w-full justify-start gap-2 rounded-none px-3" key={item.hash}>
                <a href={url} target="_blank" rel="noreferrer">{content}</a>
              </Button>
            ) : (
              <div className="flex h-9 items-center gap-2 px-3" key={item.hash}>{content}</div>
            );
          })}
          {commits.length === 0 && <p className="px-3 py-6 text-center text-[0.6875rem] text-muted-foreground">No commits yet.</p>}
        </section>
      )}

      {view === "checks" && <div id="git-activity-panel-checks" role="tabpanel" aria-labelledby="git-activity-tab-checks"><Checks checks={checks} /></div>}
    </div>
  );
}
