import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { ArtifactStore } from "./artifacts/artifactStore.ts";
import { loadForgeConfig } from "./config.ts";
import { ForgeEventService } from "./events/eventService.ts";
import { ForgeHttpServer } from "./http/server.ts";
import { EventProjectResolver } from "./projects/projectResolver.ts";
import { LiveIndicatorsService } from "./runtime/indicators.ts";
import { SessionManager } from "./runtime/sessionManager.ts";
import { ForgeDatabase } from "./store/database.ts";
import { TerminalHistoryStore } from "./terminal/historyStore.ts";
import { TerminalManager } from "./terminal/terminalManager.ts";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const config = loadForgeConfig();
  mkdirSync(config.sessionDir, { recursive: true, mode: 0o700 });
  const database = new ForgeDatabase(config.databasePath);
  const artifacts = new ArtifactStore(config.artifactDir);
  const events = new ForgeEventService(database, config.projects, artifacts);
  const projects = new EventProjectResolver(events);
  const sessions = new SessionManager(config, database, events, { projectResolver: projects });
  const terminalHistory = new TerminalHistoryStore(
    config.terminalHistoryDir ?? join(dirname(config.databasePath), "terminal-history"),
  );
  const terminals = new TerminalManager(database, projects, terminalHistory);
  const indicators = new LiveIndicatorsService(sessions);
  let shutdownPromise: Promise<void> | undefined;
  let server: ForgeHttpServer;
  const shutdown = (exitCode = 0): Promise<void> => {
    if (exitCode !== 0) process.exitCode = exitCode;
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await Promise.all([
        server.close(),
        sessions.stopAll(),
        terminals.stopAll(),
      ]);
      events.checkpoint();
      database.close();
    })();
    return shutdownPromise;
  };
  const stop = () => void shutdown();
  server = new ForgeHttpServer({
    events,
    artifacts,
    handleCommand: sessions.handleCommand,
    indicators,
    terminals,
    searchFiles: sessions.searchFiles,
    requestRebuild: async () => {
      await execFileAsync("corepack", ["pnpm", "--filter", "@anvil/web", "build"], {
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
      });
    },
    ownerLogin: config.ownerLogin,
    webRoot: config.webRoot,
  });

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await server.listen(config.host, config.port);
  process.stdout.write(`Anvil Forge listening on http://${config.host}:${config.port}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
