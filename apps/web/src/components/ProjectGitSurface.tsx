import type { ProjectGitLastCommit, ProjectGitStatus } from "@anvil/protocol";
import { Alert02Icon, GithubIcon, LinkSquare02Icon, Loading03Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  commitAndPushProject,
  generateProjectCommitMessage,
  getProjectGitCommits,
  getProjectGitStatus,
  ProjectGitRequestError,
} from "@/lib/projectGit";
import { ProjectGitConnectDialog } from "./ProjectGitConnectDialog";
import { projectGitPresentation } from "./projectGitPresentation";
import { ProjectGitStatusPanel } from "./ProjectGitStatusPanel";

type GitPhase = "idle" | "generating" | "committing" | "pushing";

export function ProjectGitSurface({
  projectId,
  projectName,
  sessionId,
  onComplete,
  onOpenFile,
}: {
  projectId: string;
  projectName: string;
  sessionId?: string;
  onComplete?: () => void;
  onOpenFile: (path: string) => void;
}) {
  const [status, setStatus] = useState<ProjectGitStatus>();
  const [error, setError] = useState<string>();
  const [phase, setPhase] = useState<GitPhase>("idle");
  const [connectOpen, setConnectOpen] = useState(false);
  const [commits, setCommits] = useState<ProjectGitLastCommit[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [nextCommitOffset, setNextCommitOffset] = useState<number | null>(0);
  const [commitTotal, setCommitTotal] = useState(0);
  const phaseRef = useRef<GitPhase>(phase);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const commitRequestRef = useRef<AbortController | undefined>(undefined);
  const nextCommitOffsetRef = useRef<number | null>(0);
  phaseRef.current = phase;

  const refresh = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setError(undefined);
    try {
      const local = await getProjectGitStatus(projectId, controller.signal, { localOnly: true });
      if (controller.signal.aborted) return;
      setStatus(local);
      const remote = await getProjectGitStatus(projectId, controller.signal);
      if (!controller.signal.aborted) setStatus(remote);
    } catch (nextError) {
      if (controller.signal.aborted) return;
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [projectId]);

  const loadCommits = useCallback(async (reset = false) => {
    if (commitRequestRef.current && !reset) return;
    if (reset) commitRequestRef.current?.abort();
    const offset = reset ? 0 : nextCommitOffsetRef.current;
    if (offset === null) return;
    const controller = new AbortController();
    commitRequestRef.current = controller;
    setCommitsLoading(true);
    try {
      const page = await getProjectGitCommits(projectId, offset, 50, controller.signal);
      if (controller.signal.aborted) return;
      setCommits((current) => reset ? page.commits : [
        ...current,
        ...page.commits.filter((commit) => !current.some((existing) => existing.hash === commit.hash)),
      ]);
      nextCommitOffsetRef.current = page.nextOffset;
      setNextCommitOffset(page.nextOffset);
      setCommitTotal(page.total);
    } catch (nextError) {
      if (!controller.signal.aborted) {
        toast.error("Could not load commit history", { description: nextError instanceof Error ? nextError.message : String(nextError) });
      }
    } finally {
      if (commitRequestRef.current === controller) {
        commitRequestRef.current = undefined;
        setCommitsLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    setStatus(undefined);
    setCommits([]);
    nextCommitOffsetRef.current = 0;
    setNextCommitOffset(0);
    setCommitTotal(0);
    void refresh();
    void loadCommits(true);
    const timer = window.setInterval(() => {
      if (phaseRef.current === "idle") void refresh();
    }, 30_000);
    return () => {
      window.clearInterval(timer);
      requestRef.current?.abort();
      commitRequestRef.current?.abort();
    };
  }, [loadCommits, refresh]);

  const presentation = status ? projectGitPresentation(status) : undefined;
  const actionLabel = phase === "generating"
    ? "Generating…"
    : phase === "committing"
      ? "Committing & pushing…"
      : phase === "pushing"
        ? "Pushing…"
        : presentation?.actionLabel;

  const run = async () => {
    if (!status || phase !== "idle" || status.action === "unavailable" || status.action === "up-to-date") return;
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
    } catch (nextError) {
      if (nextError instanceof ProjectGitRequestError && nextError.committed) {
        toast.error("Committed, but push failed", {
          description: nextError.commitMessage
            ? `${nextError.commit ?? "Commit created"} · ${nextError.commitMessage}. ${nextError.message}`
            : nextError.message,
          duration: 10_000,
        });
        onComplete?.();
      } else {
        toast.error("Git action failed", { description: nextError instanceof Error ? nextError.message : String(nextError), duration: 10_000 });
      }
    } finally {
      setPhase("idle");
      void refresh();
      void loadCommits(true);
    }
  };

  if (!status && !error) {
    return (
      <div className="grid gap-5 p-4" role="status" aria-label="Loading GitHub activity">
        <div className="flex items-center gap-3"><Skeleton className="size-8 rounded-md" /><div className="grid flex-1 gap-2"><Skeleton className="h-3 w-28" /><Skeleton className="h-2.5 w-20" /></div></div>
        <div className="grid gap-2"><Skeleton className="h-2.5 w-24" />{Array.from({ length: 5 }, (_, index) => <Skeleton className="h-9 w-full" key={index} />)}</div>
        <div className="grid gap-2"><Skeleton className="h-2.5 w-20" />{Array.from({ length: 3 }, (_, index) => <Skeleton className="h-9 w-full" key={index} />)}</div>
      </div>
    );
  }

  if (!status) {
    return (
      <Empty className="h-full rounded-none p-6">
        <EmptyHeader>
          <EmptyMedia variant="icon"><HugeiconsIcon icon={Alert02Icon} strokeWidth={2} /></EmptyMedia>
          <EmptyTitle>Git activity unavailable</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
          <Button size="sm" variant="outline" onClick={() => void refresh()}><HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />Try again</Button>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      {error && (
        <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/20 px-3 py-2 text-[0.6875rem] text-muted-foreground" role="status">
          <span className="truncate">Could not refresh remote activity</span>
          <Button variant="ghost" size="icon-xs" aria-label="Retry GitHub refresh" onClick={() => void refresh()}><HugeiconsIcon icon={RefreshIcon} strokeWidth={2} /></Button>
        </div>
      )}
      <ProjectGitStatusPanel
        status={status}
        gitActionLabel={presentation?.action === "commit" || presentation?.action === "push" ? actionLabel : undefined}
        gitActionBusy={phase !== "idle"}
        onGitAction={presentation?.action === "commit" || presentation?.action === "push" ? () => void run() : undefined}
        onOpenFile={onOpenFile}
        commits={commits}
        commitsLoading={commitsLoading}
        commitTotal={commitTotal}
        hasMoreCommits={nextCommitOffset !== null}
        onLoadMoreCommits={() => void loadCommits()}
      />
      {presentation?.action === "connect" && (
        <div className="flex justify-end border-t border-border px-3 py-2">
          <Button variant="ghost" size="xs" onClick={() => setConnectOpen(true)}>
            <HugeiconsIcon icon={status.repositoryState === "not-a-repository" ? GithubIcon : LinkSquare02Icon} strokeWidth={2} />
            {presentation.actionLabel === "Choose remote" ? "Choose remote" : "Connect repository"}
          </Button>
        </div>
      )}
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
    </div>
  );
}
