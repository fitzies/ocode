import { constants } from "node:fs";
import { glob, open, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const MAX_FAVICON_BYTES = 5 * 1024 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;

const FAVICON_CANDIDATES = [
  "favicon.svg", "favicon.ico", "favicon.png",
  "public/favicon.svg", "public/favicon.ico", "public/favicon.png",
  "app/favicon.ico", "app/favicon.png", "app/icon.svg", "app/icon.png", "app/icon.ico",
  "src/favicon.ico", "src/favicon.svg", "src/app/favicon.ico", "src/app/icon.svg", "src/app/icon.png",
  "assets/icon.svg", "assets/icon.png", "assets/logo.svg", "assets/logo.png", ".idea/icon.svg",
] as const;

const ICON_SOURCE_FILES = [
  "index.html", "public/index.html", "app/routes/__root.tsx", "src/routes/__root.tsx",
  "app/root.tsx", "src/root.tsx", "src/index.html",
] as const;

const MEDIA_TYPES: Record<string, string> = {
  ".ico": "image/x-icon", ".jpeg": "image/jpeg", ".jpg": "image/jpeg",
  ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp",
};

export interface ResolvedProjectFavicon {
  body: Buffer;
  mediaType: string;
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function readBounded(path: string, maxBytes: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const file = await handle.stat();
    if (!file.isFile() || file.size > maxBytes) return null;
    return await handle.readFile();
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function existingIcon(root: string, relativePath: string): Promise<ResolvedProjectFavicon | null> {
  const mediaType = MEDIA_TYPES[extname(relativePath).toLowerCase()];
  if (!mediaType) return null;
  const requested = resolve(root, relativePath.replace(/^[/\\]+/, ""));
  if (!inside(root, requested)) return null;

  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch {
    return null;
  }
  if (!inside(root, canonical)) return null;
  const body = await readBounded(canonical, MAX_FAVICON_BYTES);
  return body ? { body, mediaType } : null;
}

async function readWorkspaceText(root: string, relativePath: string): Promise<string | null> {
  const requested = resolve(root, relativePath);
  if (!inside(root, requested)) return null;
  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch {
    return null;
  }
  if (!inside(root, canonical)) return null;
  return (await readBounded(canonical, MAX_METADATA_BYTES))?.toString("utf8") ?? null;
}

function iconHref(source: string): string | null {
  const html = source.match(/<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i);
  if (html?.[1]) return html[1];
  const object = source.match(/(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i);
  return object?.[1] ?? null;
}

async function expoIconPath(root: string): Promise<string | null> {
  const json = await readWorkspaceText(root, "app.json");
  if (json) {
    try {
      const config = JSON.parse(json) as { expo?: { icon?: unknown; adaptiveIcon?: { foregroundImage?: unknown } } };
      const icon = config.expo?.icon ?? config.expo?.adaptiveIcon?.foregroundImage;
      if (typeof icon === "string" && icon.length > 0) return icon;
    } catch { /* Try static config files next. */ }
  }

  // Read static string properties only; never execute repository-controlled config code.
  for (const configFile of ["app.config.ts", "app.config.js", "app.config.mjs", "app.config.cjs"]) {
    const source = await readWorkspaceText(root, configFile);
    if (!source) continue;
    const icon = source.match(/\bicon\s*:\s*["']([^"']+)["']/)?.[1]
      ?? source.match(/\bforegroundImage\s*:\s*["']([^"']+)["']/)?.[1];
    if (icon) return icon;
  }
  return null;
}

async function resolveAtRoot(root: string): Promise<ResolvedProjectFavicon | null> {
  const expoIcon = await expoIconPath(root);
  if (expoIcon) {
    const icon = await existingIcon(root, expoIcon);
    if (icon) return icon;
  }

  for (const candidate of FAVICON_CANDIDATES) {
    const icon = await existingIcon(root, candidate);
    if (icon) return icon;
  }

  for (const sourceFile of ICON_SOURCE_FILES) {
    const source = await readWorkspaceText(root, sourceFile);
    if (!source) continue;
    const href = iconHref(source);
    if (!href) continue;
    const cleanHref = href.replace(/^\//, "");
    const icon = await existingIcon(root, `public/${cleanHref}`) ?? await existingIcon(root, cleanHref);
    if (icon) return icon;
  }
  return null;
}

async function workspacePatterns(root: string): Promise<string[]> {
  const patterns: string[] = [];
  const packageJson = await readWorkspaceText(root, "package.json");
  if (packageJson) {
    try {
      const value = JSON.parse(packageJson) as { workspaces?: unknown };
      const configured = Array.isArray(value.workspaces)
        ? value.workspaces
        : value.workspaces && typeof value.workspaces === "object"
          ? (value.workspaces as { packages?: unknown }).packages
          : undefined;
      if (Array.isArray(configured)) patterns.push(...configured.filter((item): item is string => typeof item === "string"));
    } catch { /* Other workspace manifests may still be available. */ }
  }

  const pnpmWorkspace = await readWorkspaceText(root, "pnpm-workspace.yaml");
  if (pnpmWorkspace) {
    for (const match of pnpmWorkspace.matchAll(/^\s*-\s*["']?([^"'#\s]+)["']?\s*$/gm)) {
      if (match[1]) patterns.push(match[1]);
    }
  }
  if (patterns.length === 0) patterns.push("apps/*");
  return [...new Set(patterns)].filter((pattern) => !pattern.startsWith("!") && !pattern.startsWith("/") && !pattern.split(/[\\/]/).includes(".."));
}

async function workspaceRoots(root: string): Promise<string[]> {
  const roots: string[] = [];
  for (const pattern of await workspacePatterns(root)) {
    try {
      for await (const relativePath of glob(pattern, { cwd: root })) {
        if (roots.length >= 100) return roots;
        let canonical: string;
        try {
          canonical = await realpath(resolve(root, relativePath));
        } catch {
          continue;
        }
        if (canonical !== root && inside(root, canonical) && !roots.includes(canonical)) roots.push(canonical);
      }
    } catch { /* Ignore unsupported or malformed repository glob patterns. */ }
  }
  return roots;
}

export async function resolveProjectFavicon(projectPath: string): Promise<ResolvedProjectFavicon | null> {
  let root: string;
  try {
    root = await realpath(projectPath);
  } catch {
    return null;
  }

  const rootIcon = await resolveAtRoot(root);
  if (rootIcon) return rootIcon;
  for (const workspaceRoot of await workspaceRoots(root)) {
    const icon = await resolveAtRoot(workspaceRoot);
    if (icon) return icon;
  }
  return null;
}
