import { useState } from "react";

export function ProjectFavicon({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  if (status === "error") return null;

  return (
    <img
      src={`/api/v1/projects/${encodeURIComponent(projectId)}/favicon`}
      alt=""
      aria-hidden="true"
      className={`size-3 shrink-0 rounded-[2px] object-contain ${status === "loaded" ? "" : "invisible"}`}
      onLoad={() => setStatus("loaded")}
      onError={() => setStatus("error")}
    />
  );
}
