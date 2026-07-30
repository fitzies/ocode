import type {
  ProjectGitApiError,
  ProjectGitConnectRequest,
  ProjectGitConnectResult,
  ProjectGitGeneratedMessage,
  ProjectGitPushResult,
  ProjectGitStatus,
} from "@anvil/protocol";

export class ProjectGitRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly committed = false,
    readonly commit?: string,
    readonly commitMessage?: string,
  ) {
    super(message);
  }
}

function endpoint(projectId: string, operation: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/git/${operation}`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  const value = await response.json().catch(() => undefined) as ProjectGitApiError | undefined;
  if (!response.ok) {
    throw new ProjectGitRequestError(
      typeof value?.message === "string" ? value.message : `Project Git request failed (${response.status})`,
      response.status,
      typeof value?.code === "string" ? value.code : undefined,
      value?.committed === true,
      typeof value?.commit === "string" ? value.commit : undefined,
      typeof value?.commitMessage === "string" ? value.commitMessage : undefined,
    );
  }
  return value as T;
}

export function getProjectGitStatus(projectId: string, signal?: AbortSignal): Promise<ProjectGitStatus> {
  return requestJson(endpoint(projectId, "status"), { signal });
}

export function connectProjectGit(
  projectId: string,
  input: ProjectGitConnectRequest,
): Promise<ProjectGitConnectResult> {
  return requestJson(endpoint(projectId, "connect"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function generateProjectCommitMessage(
  projectId: string,
  sessionId?: string,
): Promise<ProjectGitGeneratedMessage> {
  return requestJson(endpoint(projectId, "generate-message"), {
    method: "POST",
    body: JSON.stringify(sessionId ? { sessionId } : {}),
  });
}

export function commitAndPushProject(
  projectId: string,
  input: { message?: string; changeFingerprint?: string },
): Promise<ProjectGitPushResult> {
  return requestJson(endpoint(projectId, "commit-and-push"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}
