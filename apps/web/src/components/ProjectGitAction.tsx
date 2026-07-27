import type { ProjectGitStatus } from "@anvil/protocol";
import { GitCommitIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  commitAndPushProject,
  generateProjectCommitMessage,
  getProjectGitStatus,
  ProjectGitRequestError,
} from "@/lib/projectGit";

type GitPhase = "idle" | "generating" | "committing" | "pushing";

export function ProjectGitAction({
  projectId,
  sessionId,
  onComplete,
}: {
  projectId: string;
  sessionId?: string;
  onComplete?: () => void;
}) {
  const [status, setStatus] = useState<ProjectGitStatus>();
  const [phase, setPhase] = useState<GitPhase>("idle");
  const operationRef = useRef(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await getProjectGitStatus(projectId, signal);
      if (!signal?.aborted) setStatus(next);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError") && !signal?.aborted) {
        setStatus(undefined);
      }
    }
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    setStatus(undefined);
    void refresh(controller.signal);
    const timer = window.setInterval(() => {
      if (!operationRef.current) void refresh(controller.signal);
    }, 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);

  if (!status || status.action === "up-to-date" || (status.action === "unavailable" && !status.branch)) return null;

  const run = async () => {
    if (operationRef.current || status.action === "unavailable") return;
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
        toast.success("Committed and pushed", {
          description: `${result.commit} · ${result.message ?? generated.message}`,
        });
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
        toast.error("Git action failed", {
          description: error instanceof Error ? error.message : String(error),
          duration: 10_000,
        });
      }
    } finally {
      operationRef.current = false;
      setPhase("idle");
      void refresh();
    }
  };

  const busy = phase !== "idle";
  const label = phase === "generating"
    ? "Generating…"
    : phase === "committing"
      ? "Committing & pushing…"
      : phase === "pushing"
        ? "Pushing…"
        : status.action === "commit-and-push" || (status.action === "unavailable" && status.changedFiles > 0)
          ? "Commit & push"
          : "Push";
  const description = status.action === "unavailable"
    ? status.reason ?? "Git action is unavailable"
    : status.action === "commit-and-push"
      ? `Sends the contents of all ${status.changedFiles} changed ${status.changedFiles === 1 ? "file" : "files"} to Pi's configured model to generate a commit message, then commits and pushes ${status.branch}`
      : `Push ${status.ahead} ${status.ahead === 1 ? "commit" : "commits"} from ${status.branch}`;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={`project-git-action${busy ? " project-git-action--busy" : ""}`}
      aria-label={`${label}. ${description}`}
      title={description}
      disabled={busy || status.action === "unavailable"}
      onClick={() => void run()}
    >
      <HugeiconsIcon icon={GitCommitIcon} strokeWidth={2} data-icon="inline-start" />
      <span>{label}</span>
    </Button>
  );
}
