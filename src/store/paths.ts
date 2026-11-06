/** Where nokey keeps its state. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Paths {
  home: string;
  config: string;
  sessions: string;
  memory: string;
  index: string;
  cache: string;
  logs: string;
  trash: string;
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.NOKEY_HOME?.trim();
  if (explicit) return resolve(explicit);
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) return join(xdg, "nokey");
  return join(homedir(), ".nokey");
}

export function paths(home = resolveHome()): Paths {
  return {
    home,
    config: join(home, "config.json"),
    sessions: join(home, "sessions"),
    memory: join(home, "memory.json"),
    index: join(home, "index.json"),
    cache: join(home, "cache"),
    logs: join(home, "logs"),
    trash: join(home, "trash"),
  };
}

export function sessionDir(home: string, id: string): string {
  return join(home, "sessions", id);
}

/** Project-scoped state lives next to the code it describes. */
export function projectMemoryPath(cwd = process.cwd()): string {
  return join(cwd, ".nokey", "memory.json");
}

export function projectStatePath(cwd = process.cwd()): string {
  return join(cwd, ".nokey", "state.json");
}

/** Files the CLI treats as project instructions, in priority order. */
export const PROJECT_DOC_FILES = ["NOKEY.md", "AGENTS.md", "CLAUDE.md", ".nokey/instructions.md"];

export function projectDocs(cwd = process.cwd()): string[] {
  return PROJECT_DOC_FILES.map((f) => join(cwd, f));
}
