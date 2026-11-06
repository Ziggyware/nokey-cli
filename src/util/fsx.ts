/** Filesystem helpers: atomic writes, safe JSON, JSONL append. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, appendFileSync, openSync, closeSync, fsyncSync, statSync } from "node:fs";
import { dirname } from "node:path";

export function ensureDir(dir: string, mode = 0o700): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode });
}

/** Write via a temp file + rename so readers never see a half-written file. */
export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, data, { encoding: "utf8", mode });
  try {
    chmodSync(tmp, mode);
  } catch {
    /* best effort (windows) */
  }
  renameSync(tmp, path);
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function readJsonSafe<T>(path: string): T | null {
  try {
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJson(path: string, value: unknown, mode = 0o600): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n", mode);
}

/** Append one JSON line, flushing to disk so a crash cannot lose the turn. */
export function appendJsonl(path: string, value: unknown): void {
  ensureDir(dirname(path));
  const line = JSON.stringify(value) + "\n";
  appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
}

/** Durable append: fsync the file handle after writing. */
export function appendJsonlDurable(path: string, value: unknown): void {
  ensureDir(dirname(path));
  const fd = openSync(path, "a", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + "\n", { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readJsonl<T>(path: string): T[] {
  const out: T[] = [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // A torn final line from a crash is expected; skip it.
    }
  }
  return out;
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function removeIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}

export function safeFileName(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "untitled";
}
