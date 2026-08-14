import type { ProjectGitCheck, ProjectGitLastCommit, ProjectGitPullRequest, ProjectGitStatus } from "@anvil/protocol";
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
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted/50">{checkIcon(check)}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[0.75rem] font-normal text-foreground">{check.name}</span>
        {check.workflow && check.workflow !== check.name && (
          <span className="block truncate text-[0.5625rem] text-muted-foreground">{check.workflow}</span>
        )}
      </span>
      <span className={cn(
        "shrink-0 whitespace-nowrap text-[0.625rem] text-muted-foreground",
        check.state === "running" && "text-[var(--status-info)]",
        check.state === "failed" && "text-[var(--red)]",
        check.state === "passed" && "text-[var(--green)]",
      )}>{stateLabel(check)}</span>
    </>
  );

  return check.url ? (
    <Button asChild variant="ghost" size="sm" className="h-10 w-full justify-start gap-2.5 rounded-none px-3 font-normal">
      <a href={check.url} target="_blank" rel="noreferrer">{content}</a>
    </Button>
  ) : (
    <div className="flex h-10 items-center gap-2.5 px-3">{content}</div>
  );
}

function CheckGroup({ label, checks }: { label: string; checks: ProjectGitCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <section aria-label={label} className="py-1.5">
      <h3 className="px-3 pb-1 pt-1 text-[0.5625rem] font-medium uppercase tracking-wide text-muted-foreground">{label}</h3>
      {checks.map((check, index) => <CheckRow key={`${check.name}-${index}`} check={check} />)}
    </section>
  );
}

function Checks({ checks }: { checks: ProjectGitCheck[] }) {
  if (checks.length === 0) {
    return <p className="px-3 py-8 text-center text-[0.6875rem] text-muted-foreground">No checks reported for the latest commit.</p>;
  }
  return (
    <div className="divide-y divide-border">
      <CheckGroup label="Deployments" checks={checks.filter((check) => check.kind === "deployment")} />
      <CheckGroup label="CI checks" checks={checks.filter((check) => check.kind === "check")} />
      <CheckGroup label="Automated reviews" checks={checks.filter((check) => check.kind === "agent")} />
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
  commits: commitHistory,
  commitsLoading = false,
  commitTotal,
  hasMoreCommits = false,
  onLoadMoreCommits,
}: {
  status: ProjectGitStatus;
  gitActionLabel?: string;
  gitActionBusy?: boolean;
  onGitAction?: () => void;
  onOpenFile?: (path: string) => void;
  commits?: ProjectGitLastCommit[];
  commitsLoading?: boolean;
  commitTotal?: number;
  hasMoreCommits?: boolean;
  onLoadMoreCommits?: () => void;
}) {
  const pullRequest = status.github?.pullRequest;
  const commit = status.github?.commit;
  const checks = commit ? commit.checks : pullRequest?.checks ?? [];
  const commits = commitHistory?.length ? commitHistory : status.recentCommits?.length ? status.recentCommits : status.lastCommit ? [status.lastCommit] : [];
  const [view, setView] = useState<GitPanelView>(status.changedFiles > 0 ? "changes" : "commits");
  const repositoryLabel = status.remote?.provider === "github" && status.remote.owner && status.remote.repository
    ? `${status.remote.owner}/${status.remote.repository}`
    : status.upstream ?? "Local repository";

  const tabs: Array<{ id: GitPanelView; label: string; count: number | string }> = [
    { id: "changes", label: "Changes", count: status.changedFiles },
    { id: "commits", label: "Commits", count: commitTotal ?? commits.length },
    { id: "checks", label: "Checks", count: checks.length },
  ];

  return (
    <div className="min-w-0 text-popover-foreground">
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[0.6875rem]">
          <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} className="size-3 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-medium text-foreground">{status.branch ?? "Repository"}</span>
          <span className="text-muted-foreground/60">·</span>
          <span className="truncate text-muted-foreground">{repositoryLabel}</span>
        </div>
        {onGitAction && gitActionLabel && (
          <Button
            variant="link"
            size="xs"
            className="h-auto shrink-0 bg-transparent p-0 text-[0.6875rem] font-normal text-foreground hover:text-foreground"
            onClick={onGitAction}
            disabled={gitActionBusy}
            aria-label={gitActionLabel}
          >
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
            variant="ghost"
            size="sm"
            className={cn(
              "relative h-7 gap-1.5 rounded-none px-2.5 text-[0.6875rem] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground",
              view === tab.id && "text-foreground after:absolute after:inset-x-2 after:-bottom-1.5 after:h-px after:bg-foreground",
            )}
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
        <section id="git-activity-panel-commits" role="tabpanel" aria-label="Commit history" className="py-1.5">
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
          {commits.length === 0 && !commitsLoading && <p className="px-3 py-6 text-center text-[0.6875rem] text-muted-foreground">No commits yet.</p>}
          {commitsLoading && commits.length === 0 && <div className="flex justify-center py-8" role="status" aria-label="Loading commit history"><HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="size-4 animate-spin text-muted-foreground" /></div>}
          {(hasMoreCommits || (commitsLoading && commits.length > 0)) && (
            <div className="px-3 py-2">
              <Button type="button" variant="ghost" size="sm" className="w-full text-[0.6875rem] text-muted-foreground" disabled={commitsLoading} onClick={onLoadMoreCommits}>
                {commitsLoading ? <><HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="animate-spin" />Loading older commits…</> : "Load older commits"}
              </Button>
            </div>
          )}
        </section>
      )}

      {view === "checks" && <div id="git-activity-panel-checks" role="tabpanel" aria-labelledby="git-activity-tab-checks"><Checks checks={checks} /></div>}
    </div>
  );
}
