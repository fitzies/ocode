import { useEffect, useState } from "react";

import { projectFileMediaUrl } from "@/lib/projectFiles";

export function createImageObjectUrl(blob: Blob, api: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL) {
  const url = api.createObjectURL(blob);
  return { url, dispose: () => api.revokeObjectURL(url) };
}

export async function loadProjectImageObjectUrl(
  projectId: string,
  path: string,
  signal: AbortSignal,
  options: {
    fetch?: typeof fetch;
    urlApi?: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  } = {},
): Promise<ReturnType<typeof createImageObjectUrl> | undefined> {
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(projectFileMediaUrl(projectId, path), { signal });
  if (!response.ok) {
    const error = await response.json().catch(() => undefined) as { message?: string } | undefined;
    throw new Error(error?.message ?? `Image request failed (${response.status})`);
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0];
  if (!mediaType || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mediaType)) {
    throw new Error("Forge returned an unsupported image type");
  }
  const blob = await response.blob();
  if (signal.aborted) return undefined;
  const objectUrl = createImageObjectUrl(blob, options.urlApi);
  if (signal.aborted) {
    objectUrl.dispose();
    return undefined;
  }
  return objectUrl;
}

export function ProjectImageViewer({ projectId, path, alt }: {
  projectId: string;
  path: string;
  alt: string;
}) {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; url?: string; error?: string }>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: ReturnType<typeof createImageObjectUrl> | undefined;
    setState({ status: "loading" });
    void loadProjectImageObjectUrl(projectId, path, controller.signal)
      .then((loaded) => {
        objectUrl = loaded;
        if (loaded && !controller.signal.aborted) setState({ status: "ready", url: loaded.url });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      controller.abort();
      objectUrl?.dispose();
    };
  }, [path, projectId]);

  if (state.status === "loading") return <div className="resource-loading" role="status">Loading image…</div>;
  if (state.status === "error") return <div className="resource-error" role="alert">{state.error}</div>;
  return <div className="resource-image-canvas"><img src={state.url} alt={alt} /></div>;
}
