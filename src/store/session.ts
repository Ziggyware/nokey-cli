/**
 * Sessions.
 *
 * A session is an append-only event log plus a materialised view of a message
 * *tree*: every message points at its parent, so editing or regenerating
 * creates a sibling instead of destroying history. The active leaf decides
 * which path is the conversation. That is what makes `/branch`, `/edit` and
 * `/retry` lossless.
 *
 * On disk:
 *   ~/.nokey/sessions/<id>/meta.json     — small, rewritten atomically
 *   ~/.nokey/sessions/<id>/events.jsonl  — append-only, fsynced per turn
 *   ~/.nokey/sessions/<id>/memory.json   — session-scoped memories
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendJsonlDurable, ensureDir, readJsonSafe, readJsonl, writeJson } from "../util/fsx.ts";
import { newId } from "../util/ids.ts";
import { estimateTokens } from "../util/tokens.ts";
import { paths, sessionDir } from "./paths.ts";

export type Role = "user" | "assistant" | "system" | "tool" | "summary";

export interface ToolCallRecord {
  id?: string;
  name: string;
  arguments: string;
  result?: string;
  ok?: boolean;
}

export interface TelemetrySummary {
  attempts?: number;
  endpoints?: number;
  degraded?: boolean;
  traceId?: string;
  ttftMs?: number;
  totalMs?: number;
  model?: string;
  lane?: string;
  promptTokens?: number;
  completionTokens?: number;
  tokensPerSec?: number;
  finishReason?: string;
}

export interface Message {
  id: string;
  parentId: string | null;
  role: Role;
  content: string;
  reasoning?: string;
  createdAt: number;
  updatedAt?: number;
  editedAt?: number;
  model?: string;
  lane?: string;
  telemetry?: TelemetrySummary;
  toolCalls?: ToolCallRecord[];
  toolCallId?: string;
  toolName?: string;
  error?: string;
  pinned?: boolean;
  hidden?: boolean;
  feedback?: "up" | "down";
  tokens?: number;
  summaryOf?: string[];
  memoryRefs?: string[];
  finishReason?: string;
  /** Marks synthetic system messages injected by the CLI itself. */
  systemKind?: "persona" | "memory" | "compaction" | "project";
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  lane?: string;
  systemPrompt: string;
  leafId: string | null;
  messageCount: number;
  tokens: number;
  cwd?: string;
  starred?: boolean;
  tags?: string[];
  /** Ids of compaction summaries, newest last. */
  compactions?: string[];
  lastError?: string;
}

export type SessionEvent =
  | { t: "create"; ts: number; meta: SessionMeta }
  | { t: "message"; ts: number; msg: Message }
  | { t: "update"; ts: number; id: string; patch: Partial<Message> }
  | { t: "hide"; ts: number; id: string }
  | { t: "leaf"; ts: number; id: string | null }
  | { t: "meta"; ts: number; patch: Partial<SessionMeta> }
  | { t: "compaction"; ts: number; summaryId: string; covers: string[] };

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  messageCount: number;
  tokens: number;
  model: string;
  cwd?: string;
  starred?: boolean;
  preview: string;
}

const TITLE_MAX = 64;

export function deriveTitle(text: string, max = TITLE_MAX): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_>`~\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Untitled session";
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

/** In-memory conversation tree with durable append-only persistence. */
export class Session {
  meta: SessionMeta;
  messages = new Map<string, Message>();
  #dir: string;
  #eventsPath: string;
  #dirtyMeta = false;

  constructor(meta: SessionMeta, dir: string) {
    this.meta = meta;
    this.#dir = dir;
    this.#eventsPath = join(dir, "events.jsonl");
  }

  get id(): string {
    return this.meta.id;
  }

  get dir(): string {
    return this.#dir;
  }

  get eventsPath(): string {
    return this.#eventsPath;
  }

  static filePaths(home: string, id: string): { dir: string; meta: string; events: string; memory: string } {
    const dir = sessionDir(home, id);
    return { dir, meta: join(dir, "meta.json"), events: join(dir, "events.jsonl"), memory: join(dir, "memory.json") };
  }

  static create(opts: {
    home: string;
    model: string;
    systemPrompt?: string;
    cwd?: string;
    title?: string;
    id?: string;
    lane?: string;
  }): Session {
    const id = opts.id ?? newId("s_");
    const now = Date.now();
    const files = Session.filePaths(opts.home, id);
    ensureDir(files.dir);
    const meta: SessionMeta = {
      id,
      title: opts.title ?? "New session",
      createdAt: now,
      updatedAt: now,
      model: opts.model,
      lane: opts.lane,
      systemPrompt: opts.systemPrompt ?? "",
      leafId: null,
      messageCount: 0,
      tokens: 0,
      cwd: opts.cwd ?? process.cwd(),
    };
    const session = new Session(meta, files.dir);
    appendJsonlDurable(files.events, { t: "create", ts: now, meta } satisfies SessionEvent);
    writeJson(files.meta, meta);
    return session;
  }

  static load(home: string, id: string): Session | null {
    const files = Session.filePaths(home, id);
    const meta = readJsonSafe<SessionMeta>(files.meta);
    if (!meta) return null;
    const session = new Session(meta, files.dir);
    const events = readJsonl<SessionEvent>(files.events);
    session.replay(events);
    return session;
  }

  replay(events: SessionEvent[]): void {
    for (const ev of events) {
      switch (ev.t) {
        case "create":
          this.meta = { ...ev.meta, ...this.meta, leafId: ev.meta.leafId };
          break;
        case "message":
          this.messages.set(ev.msg.id, ev.msg);
          break;
        case "update": {
          const existing = this.messages.get(ev.id);
          if (existing) this.messages.set(ev.id, { ...existing, ...ev.patch });
          break;
        }
        case "hide": {
          const existing = this.messages.get(ev.id);
          if (existing) this.messages.set(ev.id, { ...existing, hidden: true });
          break;
        }
        case "leaf":
          this.meta.leafId = ev.id;
          break;
        case "meta":
          this.meta = { ...this.meta, ...ev.patch };
          break;
        case "compaction":
          this.meta.compactions = [...(this.meta.compactions ?? []), ev.summaryId];
          break;
      }
    }
    this.#recount();
  }

  #append(ev: SessionEvent): void {
    appendJsonlDurable(this.#eventsPath, ev);
  }

  saveMeta(): void {
    writeJson(join(this.#dir, "meta.json"), this.meta);
    this.#dirtyMeta = false;
  }

  #touch(): void {
    this.meta.updatedAt = Date.now();
    this.#dirtyMeta = true;
  }

  #recount(): void {
    let count = 0;
    let tokens = 0;
    for (const m of this.messages.values()) {
      if (m.hidden) continue;
      count++;
      tokens += m.tokens ?? estimateTokens(m.content) + estimateTokens(m.reasoning ?? "");
    }
    this.meta.messageCount = count;
    this.meta.tokens = tokens;
  }

  add(message: Omit<Message, "id" | "createdAt"> & { id?: string; createdAt?: number }): Message {
    const msg: Message = {
      id: message.id ?? newId("m_"),
      createdAt: message.createdAt ?? Date.now(),
      parentId: message.parentId,
      role: message.role,
      content: message.content,
      ...(message.reasoning !== undefined ? { reasoning: message.reasoning } : {}),
      ...(message.model ? { model: message.model } : {}),
      ...(message.telemetry ? { telemetry: message.telemetry } : {}),
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolName ? { toolName: message.toolName } : {}),
      ...(message.error ? { error: message.error } : {}),
      ...(message.pinned ? { pinned: true } : {}),
      ...(message.summaryOf ? { summaryOf: message.summaryOf } : {}),
      ...(message.memoryRefs ? { memoryRefs: message.memoryRefs } : {}),
      ...(message.systemKind ? { systemKind: message.systemKind } : {}),
      ...(message.finishReason ? { finishReason: message.finishReason } : {}),
      ...(message.lane ? { lane: message.lane } : {}),
      tokens: estimateTokens(message.content) + estimateTokens(message.reasoning ?? ""),
    };
    this.messages.set(msg.id, msg);
    this.#append({ t: "message", ts: msg.createdAt, msg });
    this.meta.leafId = msg.id;
    this.#append({ t: "leaf", ts: Date.now(), id: msg.id });
    this.#touch();
    this.#recount();
    this.saveMeta();
    return msg;
  }

  update(id: string, patch: Partial<Message>): Message | null {
    const existing = this.messages.get(id);
    if (!existing) return null;
    const merged: Message = { ...existing, ...patch, updatedAt: Date.now() };
    if (patch.content !== undefined || patch.reasoning !== undefined) {
      merged.tokens = estimateTokens(merged.content) + estimateTokens(merged.reasoning ?? "");
    }
    this.messages.set(id, merged);
    this.#append({ t: "update", ts: Date.now(), id, patch });
    this.#touch();
    this.#recount();
    return merged;
  }

  hide(id: string): void {
    const msg = this.messages.get(id);
    if (!msg) return;
    this.messages.set(id, { ...msg, hidden: true });
    this.#append({ t: "hide", ts: Date.now(), id });
    // If the leaf disappears, retreat to the nearest visible ancestor.
    if (this.meta.leafId === id) {
      let ancestor = msg.parentId;
      while (ancestor && this.messages.get(ancestor)?.hidden) ancestor = this.messages.get(ancestor)?.parentId ?? null;
      this.setLeaf(ancestor ?? null);
    }
    this.#touch();
    this.#recount();
    this.saveMeta();
  }

  setLeaf(id: string | null): void {
    if (id && !this.messages.has(id)) return;
    this.meta.leafId = id;
    this.#append({ t: "leaf", ts: Date.now(), id });
    this.#touch();
    this.saveMeta();
  }

  patchMeta(patch: Partial<SessionMeta>): void {
    this.meta = { ...this.meta, ...patch };
    this.#append({ t: "meta", ts: Date.now(), patch });
    this.#touch();
    this.saveMeta();
  }

  rename(title: string): void {
    const clean = title.trim().slice(0, 200) || "Untitled session";
    this.patchMeta({ title: clean });
  }

  get leafId(): string | null {
    return this.meta.leafId;
  }

  /** Walk from a node to the root (excludes hidden messages). */
  path(leafId: string | null = this.meta.leafId): Message[] {
    const out: Message[] = [];
    let cursor = leafId ?? undefined;
    const guard = new Set<string>();
    while (cursor) {
      if (guard.has(cursor)) break;
      guard.add(cursor);
      const msg = this.messages.get(cursor);
      if (!msg) break;
      if (!msg.hidden) out.push(msg);
      cursor = msg.parentId ?? undefined;
    }
    return out.reverse();
  }

  children(id: string | null): Message[] {
    const out: Message[] = [];
    for (const m of this.messages.values()) {
      if (m.parentId === id && !m.hidden) out.push(m);
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  /** Every visible leaf — the sibling branches you can switch to. */
  leaves(): string[] {
    const hasChild = new Set<string>();
    for (const m of this.messages.values()) {
      if (m.hidden) continue;
      if (m.parentId) hasChild.add(m.parentId);
    }
    const leaves: string[] = [];
    for (const m of this.messages.values()) {
      if (m.hidden) continue;
      if (!hasChild.has(m.id)) leaves.push(m.id);
    }
    leaves.sort((a, b) => (this.messages.get(a)?.createdAt ?? 0) - (this.messages.get(b)?.createdAt ?? 0));
    return leaves;
  }

  siblings(id: string): string[] {
    const msg = this.messages.get(id);
    if (!msg) return [];
    return this.children(msg.parentId)
      .filter((m) => m.role === msg.role)
      .map((m) => m.id);
  }

  branch(id: string): void {
    this.setLeaf(id);
  }

  last(role?: Role): Message | undefined {
    const path = this.path();
    for (let i = path.length - 1; i >= 0; i--) {
      const m = path[i]!;
      if (!role || m.role === role) return m;
    }
    return undefined;
  }

  /** Session title from the first user message, unless the user set one. */
  autotitle(): void {
    const first = this.path().find((m) => m.role === "user");
    if (!first) return;
    if (this.meta.title === "New session" || this.meta.title === "Untitled session") {
      this.rename(deriveTitle(first.content));
    }
  }

  recordCompaction(summaryId: string, covers: string[]): void {
    this.#append({ t: "compaction", ts: Date.now(), summaryId, covers });
    this.meta.compactions = [...(this.meta.compactions ?? []), summaryId];
    this.#touch();
    this.saveMeta();
  }

  get dirty(): boolean {
    return this.#dirtyMeta;
  }

  preview(): string {
    const path = this.path();
    const lastAssistant = [...path].reverse().find((m) => m.role === "assistant" && m.content);
    const source = lastAssistant?.content ?? path[path.length - 1]?.content ?? "";
    return source.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  toMarkdown(): string {
    const lines: string[] = [];
    lines.push(`# ${this.meta.title}`);
    lines.push("");
    lines.push(`> session \`${this.meta.id}\` · model \`${this.meta.model}\` · created ${new Date(this.meta.createdAt).toISOString()}`);
    lines.push("");
    for (const m of this.path()) {
      if (m.systemKind && m.role === "system") continue;
      lines.push(`## ${m.role}${m.model ? ` · ${m.model}` : ""}`);
      lines.push("");
      if (m.reasoning) {
        lines.push("<details><summary>reasoning</summary>");
        lines.push("");
        lines.push(m.reasoning);
        lines.push("");
        lines.push("</details>");
        lines.push("");
      }
      if (m.toolCalls?.length) {
        for (const call of m.toolCalls) {
          lines.push("```json");
          lines.push(`// tool: ${call.name}`);
          lines.push(call.arguments);
          lines.push("```");
        }
        lines.push("");
      }
      lines.push(m.content);
      lines.push("");
    }
    return lines.join("\n");
  }
}

export interface ListOptions {
  includeArchived?: boolean;
  cwd?: string;
  limit?: number;
}

export class SessionStore {
  readonly home: string;

  constructor(home: string) {
    this.home = home;
    ensureDir(paths(home).sessions);
  }

  #dirs(): string[] {
    const root = paths(this.home).sessions;
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(root, d.name));
    } catch {
      return [];
    }
  }

  list(opts: ListOptions = {}): SessionSummary[] {
    const out: SessionSummary[] = [];
    for (const dir of this.#dirs()) {
      const metaPath = join(dir, "meta.json");
      if (!existsSync(metaPath)) continue;
      const meta = readJsonSafe<SessionMeta>(metaPath);
      if (!meta) continue;
      const preview = readPreview(dir);
      out.push({
        id: meta.id,
        title: meta.title,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        messageCount: meta.messageCount ?? 0,
        tokens: meta.tokens ?? 0,
        model: meta.model,
        cwd: meta.cwd,
        starred: meta.starred,
        preview,
      });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    const filtered = opts.cwd ? out.filter((s) => !s.cwd || s.cwd === opts.cwd) : out;
    return opts.limit ? filtered.slice(0, opts.limit) : filtered;
  }

  create(opts: Parameters<typeof Session.create>[0]): Session {
    return Session.create({ ...opts, home: this.home });
  }

  load(id: string): Session | null {
    return Session.load(this.home, id);
  }

  /** Most recent session, used by `--continue` and interactive startup. */
  latest(): Session | null {
    const [first] = this.list({ limit: 1 });
    return first ? this.load(first.id) : null;
  }

  delete(id: string): boolean {
    const dir = sessionDir(this.home, id);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  search(query: string, opts: { limit?: number; sessionId?: string } = {}): SearchHit[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const hits: SearchHit[] = [];
    const targets = opts.sessionId ? [opts.sessionId] : this.list().map((s) => s.id);
    for (const id of targets) {
      const session = this.load(id);
      if (!session) continue;
      for (const msg of session.path()) {
        const hay = `${msg.content}\n${msg.reasoning ?? ""}`.toLowerCase();
        let from = 0;
        let idx = hay.indexOf(needle, from);
        while (idx !== -1 && hits.length < (opts.limit ?? 200)) {
          const start = Math.max(0, idx - 60);
          const end = Math.min(msg.content.length, idx + needle.length + 60);
          hits.push({
            sessionId: session.id,
            sessionTitle: session.meta.title,
            messageId: msg.id,
            role: msg.role,
            snippet: msg.content.slice(start, end).replace(/\s+/g, " ").trim(),
            offset: idx,
          });
          from = idx + needle.length;
          idx = hay.indexOf(needle, from);
          if (hits.length >= (opts.limit ?? 200)) break;
        }
      }
    }
    return hits;
  }

  exportJson(session: Session): string {
    const events = readJsonl<SessionEvent>(session.eventsPath);
    return JSON.stringify({ format: "nokey-session", version: 1, meta: session.meta, events }, null, 2);
  }

  importJson(json: string): Session {
    const parsed = JSON.parse(json) as { format?: string; meta?: SessionMeta; events?: SessionEvent[] };
    if (!parsed.meta || !Array.isArray(parsed.events)) throw new Error("Not a nokey session export");
    const id = newId("s_");
    const files = Session.filePaths(this.home, id);
    ensureDir(files.dir);
    const meta: SessionMeta = { ...parsed.meta, id, updatedAt: Date.now() };
    writeJson(files.meta, meta);
    const body = parsed.events
      .filter((e) => e.t !== "create")
      .map((e) => JSON.stringify(e))
      .join("\n");
    writeFileSync(files.events, `${JSON.stringify({ t: "create", ts: Date.now(), meta } satisfies SessionEvent)}\n${body}${body ? "\n" : ""}`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const session = Session.load(this.home, id);
    if (!session) throw new Error("Failed to load imported session");
    return session;
  }

  /** Compact the log by rewriting it from the materialised tree. */
  compactLog(session: Session): { before: number; after: number } {
    const before = readJsonl<SessionEvent>(session.eventsPath).length;
    const events: SessionEvent[] = [{ t: "create", ts: session.meta.createdAt, meta: session.meta }];
    const ordered = [...session.messages.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const msg of ordered) events.push({ t: "message", ts: msg.createdAt, msg });
    for (const id of session.meta.compactions ?? []) events.push({ t: "compaction", ts: Date.now(), summaryId: id, covers: [] });
    events.push({ t: "leaf", ts: Date.now(), id: session.meta.leafId });
    writeJson(join(session.dir, "meta.json"), session.meta);
    writeFileSync(session.eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    return { before, after: events.length };
  }

  stats(): { sessions: number; bytes: number } {
    let bytes = 0;
    let sessions = 0;
    for (const dir of this.#dirs()) {
      sessions++;
      for (const file of ["events.jsonl", "meta.json", "memory.json"]) {
        try {
          bytes += readFileSync(join(dir, file)).byteLength;
        } catch {
          /* missing */
        }
      }
    }
    return { sessions, bytes };
  }
}

export interface SearchHit {
  sessionId: string;
  sessionTitle: string;
  messageId: string;
  role: Role;
  snippet: string;
  offset: number;
}

function readPreview(dir: string): string {
  const eventsPath = join(dir, "events.jsonl");
  try {
    const raw = readFileSync(eventsPath, "utf8");
    const lines = raw.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes('"assistant"') && !line.includes('"user"')) continue;
      try {
        const ev = JSON.parse(line) as SessionEvent;
        if (ev.t !== "message" || ev.msg.hidden) continue;
        const text = ev.msg.content.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
        if (text) return text.slice(0, 120);
      } catch {
        /* skip torn line */
      }
    }
  } catch {
    /* missing */
  }
  return "";
}
