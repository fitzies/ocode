import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { spawn, type IPty } from "node-pty";

import type { PtyAdapter, PtyProcess, PtySpawnOptions } from "./ptyAdapter.ts";

function shellExecutable(): string {
  const configured = process.env.SHELL;
  if (configured?.startsWith("/") && existsSync(configured)) return configured;
  if (existsSync("/bin/bash")) return "/bin/bash";
  return "/bin/sh";
}

function descendantPids(rootPid: number): number[] {
  if (process.platform === "win32") return [];
  try {
    const relationships = execFileSync("ps", ["-eo", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
    const descendants: number[] = [];
    const parents = [rootPid];
    while (parents.length > 0) {
      const parent = parents.pop()!;
      for (const [pid, ppid] of relationships) {
        if (pid && ppid === parent && !descendants.includes(pid)) {
          descendants.push(pid);
          parents.push(pid);
        }
      }
    }
    return descendants.reverse();
  } catch {
    return [];
  }
}

function wrapPty(pty: IPty): PtyProcess {
  const knownDescendants = new Set<number>();
  return {
    pid: pty.pid,
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: (signal = "SIGTERM") => {
      if (process.platform !== "win32") {
        const typedSignal = signal as NodeJS.Signals;
        for (const pid of descendantPids(pty.pid)) knownDescendants.add(pid);
        for (const pid of knownDescendants) {
          try {
            process.kill(pid, typedSignal);
          } catch {
            // A descendant may exit while the tree is being signalled.
          }
        }
        try {
          process.kill(-pty.pid, typedSignal);
          return;
        } catch {
          // Fall back to node-pty's process signal if the PTY is not a group leader.
        }
      }
      try {
        pty.kill(signal);
      } catch {
        // The PTY root may already have exited while retained descendants are cleaned up.
      }
    },
    onData: (listener) => pty.onData(listener),
    onExit: (listener) => pty.onExit(({ exitCode, signal }) => listener({ exitCode, signal })),
  };
}

export class NodePtyAdapter implements PtyAdapter {
  spawn(options: PtySpawnOptions): PtyProcess {
    return wrapPty(spawn(shellExecutable(), [], {
      name: "xterm-256color",
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      env: options.env,
    }));
  }
}
