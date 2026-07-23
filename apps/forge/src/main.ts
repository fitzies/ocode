import { mkdirSync } from "node:fs";

import { loadForgeConfig } from "./config.ts";
import { ForgeEventService } from "./events/eventService.ts";
import { ForgeHttpServer } from "./http/server.ts";
import { SessionManager } from "./runtime/sessionManager.ts";
import { ForgeDatabase } from "./store/database.ts";

async function main(): Promise<void> {
  const config = loadForgeConfig();
  mkdirSync(config.sessionDir, { recursive: true, mode: 0o700 });
  const database = new ForgeDatabase(config.databasePath);
  const events = new ForgeEventService(database, config.projects);
  const sessions = new SessionManager(config, database, events);
  const server = new ForgeHttpServer({
    events,
    handleCommand: sessions.handleCommand,
    ownerLogin: config.ownerLogin,
    webRoot: config.webRoot,
  });

  const shutdown = async () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await server.close();
    await sessions.stopAll();
    events.checkpoint();
    database.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.listen(config.host, config.port);
  process.stdout.write(`Anvil Forge listening on http://${config.host}:${config.port}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
