import { useEffect } from "react";

const STORAGE_KEY = "ocode.ui-zoom";
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const STEP = 0.1;

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 10) / 10));
}

function readStoredZoom(): number | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === null) return null;
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? clampZoom(parsed) : null;
  } catch {
    return null;
  }
}

export function readZoom(): number {
  return readStoredZoom() ?? 1;
}

async function applyZoomToWebview(factor: number): Promise<boolean> {
  try {
    if (!("__TAURI_INTERNALS__" in window)) return false;
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    await getCurrentWebviewWindow().setZoom(factor);
    return true;
  } catch {
    return false;
  }
}

function applyZoomFallback(factor: number): void {
  try {
    document.documentElement.style.setProperty("zoom", String(factor));
  } catch {
    // ignore
  }
}

export async function applyZoom(factor: number): Promise<void> {
  const clamped = clampZoom(factor);
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clamped));
  } catch {
    // ignore
  }
  const handled = await applyZoomToWebview(clamped);
  if (!handled) applyZoomFallback(clamped);
}

export interface ZoomKeyEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  key: string;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export function handleZoomKey(event: ZoomKeyEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  if (event.key !== "=" && event.key !== "+" && event.key !== "-" && event.key !== "_" && event.key !== "0") {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "0") {
    void applyZoom(1);
  } else if (event.key === "-" || event.key === "_") {
    void applyZoom(readZoom() - STEP);
  } else {
    void applyZoom(readZoom() + STEP);
  }
  return true;
}

export function useAppZoom(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    void applyZoom(readZoom());
    const onKeyDown = (event: KeyboardEvent) => {
      handleZoomKey(event);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);
}
