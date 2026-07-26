import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ForgeEventService } from "../events/eventService.ts";
import { ProjectFileService } from "../projects/projectFileService.ts";
import { EventProjectResolver } from "../projects/projectResolver.ts";
import { ForgeDatabase } from "../store/database.ts";
import { ForgeHttpServer } from "./server.ts";

let root: string;
let database: ForgeDatabase;
let server: ForgeHttpServer;
let baseUrl: string;
const ownerHeaders = { "tailscale-user-login": "owner@example.com" };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "anvil-file-routes-"));
  writeFileSync(join(root, "page.html"), "<!doctype html><script>window.pwned=true</script>");
  writeFileSync(join(root, "pixel.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  writeFileSync(join(root, "active.svg"), "<svg onload=\"alert(1)\"></svg>");
  database = new ForgeDatabase(":memory:");
  const events = new ForgeEventService(database, [{ id: "project-1", name: "Project", path: root }]);
  const projectFiles = new ProjectFileService(new EventProjectResolver(events));
  server = new ForgeHttpServer({ events, projectFiles, ownerLogin: "owner@example.com" });
  await server.listen("127.0.0.1", 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await server.close();
  database.close();
  rmSync(root, { recursive: true, force: true });
});

describe("project file HTTP routes", () => {
  it("requires owner authentication on every resource route", async () => {
    for (const path of [
      "/metadata?path=page.html",
      "/content?path=page.html",
      "/media?path=pixel.png",
    ]) {
      expect((await fetch(`${baseUrl}/api/v1/projects/project-1/files${path}`)).status).toBe(403);
      expect((await fetch(`${baseUrl}/api/v1/projects/project-1/files${path}`, {
        headers: { "tailscale-user-login": "intruder@example.com" },
      })).status).toBe(403);
    }
  });

  it("rejects cross-site browser reads and applies same-origin resource policy", async () => {
    const rejected = await fetch(`${baseUrl}/api/v1/projects/project-1/files/media?path=pixel.png`, {
      headers: { ...ownerHeaders, "sec-fetch-site": "cross-site" },
    });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("cross-origin-resource-policy")).toBe("same-origin");

    const accepted = await fetch(`${baseUrl}/api/v1/projects/project-1/files/metadata?path=page.html`, { headers: ownerHeaders });
    expect(accepted.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("does not expose removed project tree or search routes", async () => {
    expect((await fetch(`${baseUrl}/api/v1/projects/project-1/files/search?q=page`, { headers: ownerHeaders })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/v1/projects/project-1/files/tree?path=`, { headers: ownerHeaders })).status).toBe(404);
  });

  it("returns source and HTML only as inert JSON", async () => {
    const response = await fetch(`${baseUrl}/api/v1/projects/project-1/files/content?path=page.html`, { headers: ownerHeaders });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(await response.json()).toMatchObject({
      file: { path: "page.html", viewer: "html" },
      text: "<!doctype html><script>window.pwned=true</script>",
    });
  });

  it("serves allowlisted raster bytes with safe headers and rejects SVG", async () => {
    const response = await fetch(`${baseUrl}/api/v1/projects/project-1/files/media?path=pixel.png`, { headers: ownerHeaders });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toContain("inline; filename=\"pixel.png\"");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");

    const head = await fetch(`${baseUrl}/api/v1/projects/project-1/files/media?path=pixel.png`, { method: "HEAD", headers: ownerHeaders });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("9");
    expect(await head.text()).toBe("");

    const svg = await fetch(`${baseUrl}/api/v1/projects/project-1/files/media?path=active.svg`, { headers: ownerHeaders });
    expect(svg.status).toBe(415);
    expect(await svg.json()).toMatchObject({ code: "unsupported_media" });
  });

  it.each([
    "/metadata?path=%2Fetc%2Fpasswd",
    "/metadata?path=..%2Fsecret",
    "/metadata?path=bad%00path",
    "/metadata?path=%E0%A4%A",
  ])("rejects malformed or unsafe request paths: %s", async (path) => {
    const response = await fetch(`${baseUrl}/api/v1/projects/project-1/files${path}`, { headers: ownerHeaders });
    expect(response.status).toBe(400);
  });
});
