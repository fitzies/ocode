import type { ProjectGitCheck, ProjectGitPullRequest, ProjectGitStatus } from "@anvil/protocol";

export type ProjectGitTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface ProjectGitHeaderPresentation {
  label: string;
  tone: ProjectGitTone;
  action?: "connect" | "commit" | "push" | "repair";
  actionLabel?: string;
  busy: boolean;
}

export function projectGitCheckSummary(checks: readonly ProjectGitCheck[]) {
  const passed = checks.filter((check) => check.state === "passed").length;
  const running = checks.filter((check) => check.state === "running" || check.state === "queued").length;
  const failed = checks.filter((check) => check.state === "failed").length;
  return { passed, running, failed, total: checks.length };
}

export function projectGitDeliveryCompletion(checks: readonly ProjectGitCheck[]) {
  const summary = projectGitCheckSummary(checks);
  const terminal = checks.length > 0 && checks.every((check) => !["queued", "running", "unknown"].includes(check.state));
  const hasIssues = checks.some((check) => check.state === "failed" || check.state === "cancelled");
  return { ...summary, terminal, hasIssues };
}

function pullRequestPresentation(pullRequest: ProjectGitPullRequest): Pick<ProjectGitHeaderPresentation, "label" | "tone" | "busy"> {
  const prefix = `PR #${pullRequest.number}`;
  switch (pullRequest.status) {
    case "running": return { label: `${prefix} · Building`, tone: "info", busy: true };
    case "ready": return { label: `${prefix} · Ready`, tone: "success", busy: false };
    case "failed": return { label: `${prefix} · Checks failed`, tone: "danger", busy: false };
    case "blocked": return { label: `${prefix} · Blocked`, tone: "warning", busy: false };
    case "draft": return { label: `${prefix} · Draft`, tone: "neutral", busy: false };
    case "merged": return { label: `${prefix} · Merged`, tone: "success", busy: false };
    case "closed": return { label: `${prefix} · Closed`, tone: "neutral", busy: false };
    default: return { label: prefix, tone: "neutral", busy: false };
  }
}

export function projectGitPresentation(status: ProjectGitStatus): ProjectGitHeaderPresentation {
  const branch = status.branch ?? "Git";
  switch (status.repositoryState) {
    case "workspace-missing":
      return { label: "Workspace unavailable", tone: "danger", action: "repair", actionLabel: "Repair", busy: false };
    case "not-a-repository":
      return { label: "Repository not connected", tone: "warning", action: "connect", actionLabel: "Connect", busy: false };
    case "no-remote":
      return { label: `${branch} · No remote`, tone: "warning", action: "connect", actionLabel: "Connect", busy: false };
    case "ambiguous-remote":
      return { label: `${branch} · Choose remote`, tone: "warning", action: "connect", actionLabel: "Choose remote", busy: false };
    case "behind":
      return { label: `${branch} · ${status.behind ?? 1} behind`, tone: "warning", action: "repair", actionLabel: "View", busy: false };
    case "diverged":
      return { label: `${branch} · Diverged`, tone: "danger", action: "repair", actionLabel: "View", busy: false };
    case "detached-head":
      return { label: "Detached HEAD", tone: "warning", action: "repair", actionLabel: "View", busy: false };
    case "conflicted":
      return { label: `${branch} · Conflicts`, tone: "danger", action: "repair", actionLabel: "View", busy: false };
  }

  const localAction = status.action === "commit-and-push"
    ? { action: "commit" as const, actionLabel: "Commit & push" }
    : status.action === "push" ? { action: "push" as const, actionLabel: "Push" } : {};
  const pullRequest = status.github?.pullRequest;
  const commit = status.github?.commit;
  if (status.action === "commit-and-push") {
    return {
      label: `${branch} · ${status.changedFiles} changed`,
      tone: "info",
      ...localAction,
      busy: false,
    };
  }
  if (status.action === "push") {
    return {
      label: `${branch} · ${Math.max(status.ahead, 1)} ahead`,
      tone: "info",
      ...localAction,
      busy: false,
    };
  }
  if (status.action === "unavailable") {
    return { label: status.reason ?? "Git unavailable", tone: "warning", action: "repair", actionLabel: "View", busy: false };
  }
  if (!commit && pullRequest) return { ...pullRequestPresentation(pullRequest), ...localAction };
  return {
    label: status.remoteStatusError ? `${branch} · Status stale` : `${branch} · Clean`,
    tone: status.remoteStatusError ? "warning" : "success",
    busy: false,
  };
}
