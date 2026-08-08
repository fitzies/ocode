import { isGeneralProject, type ProjectWorkspaceKind } from "@anvil/protocol";
import { Home01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

interface ProjectFaviconProps {
  projectId: string;
  projectName?: string;
  workspaceKind?: ProjectWorkspaceKind;
  className?: string;
}

export function ProjectFavicon({ projectId, projectName, workspaceKind, className = "" }: ProjectFaviconProps) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const initial = (projectName?.trim()[0] ?? projectId.trim()[0] ?? "?").toLocaleUpperCase();

  if (isGeneralProject({ id: projectId, workspaceKind })) {
    return (
      <span
        className={`relative inline-flex size-3 shrink-0 items-center justify-center text-muted-foreground ${className}`}
        aria-hidden="true"
      >
        <HugeiconsIcon icon={Home01Icon} strokeWidth={2} className="size-3" />
      </span>
    );
  }

  return (
    <span
      className={`relative inline-flex size-3 shrink-0 items-center justify-center overflow-hidden rounded-[2px] bg-muted text-[7px] font-semibold leading-none text-muted-foreground ${className}`}
      aria-hidden="true"
    >
      {status !== "loaded" && initial}
      {status !== "error" && (
        <img
          src={`/api/v1/projects/${encodeURIComponent(projectId)}/favicon`}
          alt=""
          className={`absolute inset-0 size-full object-contain ${status === "loaded" ? "" : "invisible"}`}
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("error")}
        />
      )}
    </span>
  );
}
