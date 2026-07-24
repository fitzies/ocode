import { mkdirSync } from "node:fs";

import { ArtifactStore } from "./artifacts/artifactStore.ts";
import { loadForgeConfig } from "./config.ts";
import { ForgeEventService } from "./events/eventService.ts";
import { ForgeHttpServer } from "./http/server.ts";
import { LiveIndicatorsService } from "./runtime/indicators.ts";
import { SessionManager } from "./runtime/sessionManager.ts";
import { ForgeDatabase } from "./store/database.ts";

async function main(): Promise<void> {
  const config = loadForgeConfig();
  mkdirSync(config.sessionDir, { recursive: true, mode: 0o700 });
  const database = new ForgeDatabase(config.databasePath);
  const artifacts = new ArtifactStore(config.artifactDir);
  const events = new ForgeEventService(database, config.projects, artifacts);
  const sessions = new SessionManager(config, database, events);
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
    searchFiles: sessions.searchFiles,
    requestRestart: process.env.INVOCATION_ID ? () => void shutdown(75) : undefined,
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
