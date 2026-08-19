import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { ArtifactStore } from "./artifacts/artifactStore.ts";
import { loadForgeConfig } from "./config.ts";
import { DesktopUpdateStore } from "./desktop/desktopUpdateStore.ts";
import { ForgeEventService } from "./events/eventService.ts";
import { ForgeHttpServer } from "./http/server.ts";
import { PiCatalogService } from "./pi/piCatalogService.ts";
import { PiCommitMessageGenerator } from "./pi/commitMessageGenerator.ts";
import { prepareGeneralProject } from "./projects/generalProject.ts";
import { GitHubRepositoryCatalog } from "./projects/githubRepositoryCatalog.ts";
import { ProjectFileService } from "./projects/projectFileService.ts";
import { ProjectGitService } from "./projects/projectGitService.ts";
import { EventProjectResolver } from "./projects/projectResolver.ts";
import { LiveIndicatorsService } from "./runtime/indicators.ts";
import { SessionManager } from "./runtime/sessionManager.ts";
import { SubagentInternalApi, subagentEndpoint } from "./subagents/internalApi.ts";
import { SubagentCoordinator } from "./subagents/subagentCoordinator.ts";
import { ForgeDatabase } from "./store/database.ts";
import { acquireForgeInstanceLock, ForgeInstanceLockedError } from "./store/instanceLock.ts";
import { removeRetiredSpeechCredential } from "./store/retiredFeatureCleanup.ts";
import { TerminalHistoryStore } from "./terminal/historyStore.ts";
import { TerminalManager } from "./terminal/terminalManager.ts";
import { UsageService } from "./usage/usageService.ts";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const config = loadForgeConfig();
  const instanceLock = acquireForgeInstanceLock(config.databasePath);
  try {
    removeRetiredSpeechCredential(dirname(config.databasePath));
    mkdirSync(config.sessionDir, { recursive: true, mode: 0o700 });
    mkdirSync(config.desktopUpdateDir, { recursive: true, mode: 0o700 });
    const database = new ForgeDatabase(config.databasePath);
    const generalProject = prepareGeneralProject(database, config.projects);
    const artifacts = new ArtifactStore(config.artifactDir);
    const desktopUpdates = new DesktopUpdateStore(config.desktopUpdateDir);
    const events = new ForgeEventService(database, config.projects, artifacts);
    events.markGeneralProject(generalProject.id);
    const projects = new EventProjectResolver(events);
    const projectFiles = new ProjectFileService(projects);
    const projectGit = new ProjectGitService(projects, new PiCommitMessageGenerator(config.piExecutable));
    const githubRepositories = new GitHubRepositoryCatalog();
    const terminalHistory = new TerminalHistoryStore(
      config.terminalHistoryDir ?? join(dirname(config.databasePath), "terminal-history"),
    );
    const terminals = new TerminalManager(database, projects, terminalHistory);
    let subagentApi!: SubagentInternalApi;
    let subagents!: SubagentCoordinator;
    const sessions = new SessionManager(config, database, events, {
      projectResolver: projects,
      terminalCleanup: terminals,
      runtimeEnvironment: (session) => subagentApi.environment(session),
      cancelSubagent: async (parentSessionId, runId) => ({
        ...await subagents.cancel(parentSessionId, runId),
      }),
      deleteOwnedSubagents: (parentSessionId) => subagents.deleteOwnedChildren(parentSessionId),
      finishParentSubagentDeletion: (parentSessionId) => subagents.finishParentDeletion(parentSessionId),
      prepareChildSubagentDeletion: (childSessionId) => subagents.prepareChildDeletion(childSessionId),
    });
    subagents = new SubagentCoordinator(database, events, sessions);
    subagentApi = new SubagentInternalApi(subagents, subagentEndpoint(config.host, config.port));
    const indicators = new LiveIndicatorsService(sessions);
    const usage = new UsageService({ additionalSessionRoots: [config.sessionDir] });
    const piCatalog = new PiCatalogService();
    let shutdownPromise: Promise<void> | undefined;
    let server: ForgeHttpServer;
    const shutdown = (exitCode = 0): Promise<void> => {
      if (exitCode !== 0) process.exitCode = exitCode;
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        subagents.stop();
        await Promise.all([
          server.close(),
          sessions.stopAll(),
          terminals.stopAll(),
        ]);
        events.checkpoint();
        database.close();
        // Keep the instance lock until process exit so no replacement can start
        // while shutdown work still has a chance to write.
      })();
      return shutdownPromise;
    };
    const stop = () => void shutdown();
    server = new ForgeHttpServer({
      events,
      artifacts,
      handleCommand: sessions.handleCommand,
      indicators,
      projectFiles,
      projectGit,
      terminals,
      usage,
      piCatalog,
      subagentApi,
      searchFiles: sessions.searchFiles,
      listGitHubRepositories: githubRepositories.list,
      getProjectsRoot: sessions.getProjectsRoot,
      setProjectsRoot: sessions.setProjectsRoot,
      requestRebuild: async () => {
        await execFileAsync("corepack", ["pnpm", "--filter", "@anvil/web", "build"], {
          cwd: process.cwd(),
          maxBuffer: 10 * 1024 * 1024,
        });
      },
      desktopUpdates,
      ownerLogin: config.ownerLogin,
      webRoot: config.webRoot,
    });

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    await server.listen(config.host, config.port);
    process.stdout.write(`ocode Forge listening on http://${config.host}:${config.port}\n`);
  } catch (error) {
    instanceLock.release();
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = error instanceof ForgeInstanceLockedError ? 75 : 1;
});
