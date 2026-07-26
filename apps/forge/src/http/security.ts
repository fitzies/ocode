import type { IncomingMessage } from "node:http";

export function authorizedOwner(request: IncomingMessage, ownerLogin?: string): boolean {
  if (!ownerLogin) return true;
  const login = request.headers["tailscale-user-login"];
  return typeof login === "string" && login === ownerLogin;
}

export function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
