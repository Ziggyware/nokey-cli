/**
 * The memory bank.
 *
 * Durable, scoped facts the assistant should keep across turns and sessions:
 * preferences, decisions, constraints, entities, open tasks. Items are scored
 * with a BM25-lite lexical model, an exponential recency decay and pin/hit
 * boosts, then trimmed to a token budget before they are injected into the
 * system prompt. Nothing is injected unless it scores above zero, so an
 * unrelated session does not drag stale context along.
 *
 * Scopes:
 *   global  — ~/.kono/memory.json            (you, everywhere)
 *   project — <cwd>/.kono/memory.json        (this repository)
 *   session — ~/.kono/sessions/<id>/memory.json
 */
import { existsSync } from "node:fs";
import { readJsonSafe, writeJson } from "../util/fsx.ts";
import { newId } from "../util/ids.ts";
import { estimateTokens } from "../util/tokens.ts";

export type MemoryKind = "preference" | "fact" | "decision" | "task" | "entity" | "note";
export type MemoryScope = "global" | "project" | "session";

export interface MemoryItem {
  id: string;
  text: string;
  kind: MemoryKind;
  scope: MemoryScope;
  hash: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  hits: number;
  pinned?: boolean;
  weight?: number;
  tags?: string[];
  expiresAt?: number;
  source?: { sessionId?: string; messageId?: string; kind?: "user" | "assistant" | "manual" | "import" };
  /** Set when a newer item supersedes this one. */
  supersededBy?: string;
}

export interface MemoryFile {
  version: number;
  scope: MemoryScope;
  updatedAt: number;
  items: MemoryItem[];
}

export interface AddResult {
  item: MemoryItem;
  action: "added" | "merged" | "duplicate";
}

const STOPWORDS = new Set(
  "a an the and or but if then else for to of in on at by with from as is are was were be been being do does did doing have has had having i you he she it we they me him her them my your his its our their this that these those there here what which who whom when where why how not no nor so than too very can will just should now use using used".split(
    " ",
  ),
);

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_>#]+/g, " ")
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) {
    const trimmed = token.slice(0, -3);
    // running -> runn -> run
    return /([bdfglmnprt])\1$/.test(trimmed) ? trimmed.slice(0, -1) : trimmed;
  }
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string): string[] {
  return normalize(text)
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

export function hashText(text: string): string {
  const norm = normalize(text);
  // FNV-1a, 32-bit — enough for duplicate detection, no crypto dependency.
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared++;
  return shared / (sa.size + sb.size - shared);
}

const SIMILARITY_MERGE = 0.72;

export class MemoryBank {
  readonly path: string;
  readonly scope: MemoryScope;
  items: MemoryItem[] = [];
  #dirty = false;
  #halfLifeDays: number;

  constructor(path: string, scope: MemoryScope, opts: { halfLifeDays?: number } = {}) {
    this.path = path;
    this.scope = scope;
    this.#halfLifeDays = opts.halfLifeDays ?? 45;
    this.load();
  }

  setHalfLife(days: number): void {
    this.#halfLifeDays = Math.max(1, days);
  }

  load(): void {
    if (!existsSync(this.path)) return;
    const file = readJsonSafe<MemoryFile>(this.path);
    if (file && Array.isArray(file.items)) {
      this.items = file.items.filter((i): i is MemoryItem => Boolean(i) && typeof i.text === "string" && typeof i.id === "string");
    }
  }

  save(): void {
    if (!this.#dirty) return;
    const file: MemoryFile = { version: 1, scope: this.scope, updatedAt: Date.now(), items: this.items };
    writeJson(this.path, file);
    this.#dirty = false;
  }

  get size(): number {
    return this.items.filter((i) => !i.supersededBy).length;
  }

  add(
    text: string,
    opts: {
      kind?: MemoryKind;
      pinned?: boolean;
      tags?: string[];
      source?: MemoryItem["source"];
      /** Replace an existing near-duplicate instead of skipping it. */
      replace?: boolean;
      weight?: number;
    } = {},
  ): AddResult {
    const clean = text.replace(/\s+/g, " ").trim().replace(/^[-*]\s+/, "");
    if (!clean) throw new Error("Cannot store an empty memory");
    const hash = hashText(clean);
    const tokens = tokenize(clean);
    const now = Date.now();

    const exact = this.items.find((i) => i.hash === hash && !i.supersededBy);
    if (exact) {
      exact.hits += 1;
      exact.lastUsedAt = now;
      this.#dirty = true;
      this.save();
      return { item: exact, action: "duplicate" };
    }
    if (!opts.replace) {
      const near = this.items.find((i) => !i.supersededBy && jaccard(tokenize(i.text), tokens) >= SIMILARITY_MERGE);
      if (near) {
        // Keep the more informative phrasing.
        if (clean.length > near.text.length) near.text = clean;
        near.updatedAt = now;
        near.hits += 1;
        near.kind = opts.kind ?? near.kind;
        if (opts.pinned) near.pinned = true;
        this.#dirty = true;
        this.save();
        return { item: near, action: "merged" };
      }
    }

    const item: MemoryItem = {
      id: newId("mem_"),
      text: clean.slice(0, 1200),
      kind: opts.kind ?? "note",
      scope: this.scope,
      hash,
      createdAt: now,
      updatedAt: now,
      hits: 0,
      ...(opts.pinned ? { pinned: true } : {}),
      ...(opts.tags?.length ? { tags: opts.tags } : {}),
      ...(opts.source ? { source: opts.source } : {}),
      ...(opts.weight !== undefined ? { weight: opts.weight } : {}),
    };
    this.items.push(item);
    this.#dirty = true;
    this.save();
    return { item, action: "added" };
  }

  remove(idOrIndex: string): MemoryItem | null {
    const idx = this.items.findIndex((i) => i.id === idOrIndex);
    if (idx === -1) return null;
    const [item] = this.items.splice(idx, 1);
    this.#dirty = true;
    this.save();
    return item ?? null;
  }

  update(id: string, patch: Partial<MemoryItem>): MemoryItem | null {
    const item = this.items.find((i) => i.id === id);
    if (!item) return null;
    Object.assign(item, patch, { updatedAt: Date.now() });
    if (patch.text) item.hash = hashText(patch.text);
    this.#dirty = true;
    this.save();
    return item;
  }

  find(prefix: string): MemoryItem | undefined {
    const exact = this.items.find((i) => i.id === prefix);
    if (exact) return exact;
    const matches = this.items.filter((i) => i.id.startsWith(prefix));
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** BM25-lite score for one item against a query. */
  score(item: MemoryItem, queryTokens: string[], idf: Map<string, number>, now = Date.now()): number {
    const itemTokens = tokenize(item.text);
    let lexical = 0;
    const counts = new Map<string, number>();
    for (const t of itemTokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const q of queryTokens) {
      const tf = counts.get(q) ?? 0;
      if (!tf) continue;
      const weight = idf.get(q) ?? 1;
      lexical += weight * (tf / (tf + 1.2));
    }
    if (lexical === 0 && !item.pinned) return 0;
    const ageDays = Math.max(0, (now - (item.lastUsedAt ?? item.updatedAt)) / 86_400_000);
    const recency = Math.pow(0.5, ageDays / Math.max(1, this.#halfLifeDays));
    const kindBoost: Record<MemoryKind, number> = {
      preference: 1.35,
      decision: 1.3,
      task: 1.15,
      entity: 1.1,
      fact: 1.1,
      note: 1,
    };
    const hitBoost = 1 + Math.min(0.5, item.hits * 0.05);
    // Pins make an item *eligible* even with no lexical overlap, and give it a
    // modest lift — but a directly relevant memory still wins the top slot.
    const pinBoost = item.pinned ? 1.4 : 1;
    const manual = item.source?.kind === "manual" ? 1.2 : 1;
    return (lexical + (item.pinned ? 0.3 : 0)) * recency * pinBoost * hitBoost * (kindBoost[item.kind] ?? 1) * manual * (item.weight ?? 1);
  }

  /** Ranked, budget-limited selection for prompt injection. */
  retrieve(
    query: string,
    opts: { topK?: number; tokenBudget?: number; now?: number; includePinned?: boolean } = {},
  ): MemoryItem[] {
    const now = opts.now ?? Date.now();
    const topK = opts.topK ?? 8;
    const budget = opts.tokenBudget ?? 900;
    const live = this.items.filter((i) => !i.supersededBy && (!i.expiresAt || i.expiresAt > now));
    if (!live.length || topK <= 0) return [];

    const queryTokens = tokenize(query);
    // Document frequency for the IDF component.
    const df = new Map<string, number>();
    for (const item of live) {
      for (const t of new Set(tokenize(item.text))) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const idf = new Map<string, number>();
    for (const [t, n] of df) idf.set(t, Math.log(1 + live.length / (1 + n)) + 1);

    const scored = live
      .map((item) => ({ item, score: this.score(item, queryTokens, idf, now) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    const out: MemoryItem[] = [];
    let used = 0;
    for (const { item } of scored) {
      const cost = estimateTokens(item.text) + 6;
      if (out.length >= topK) break;
      if (used + cost > budget) continue;
      out.push(item);
      used += cost;
    }
    return out;
  }

  /** Mark items as used so recency and hit counts reflect real usage. */
  touch(items: MemoryItem[], now = Date.now()): void {
    for (const item of items) {
      const live = this.items.find((i) => i.id === item.id);
      if (!live) continue;
      live.hits += 1;
      live.lastUsedAt = now;
    }
    if (items.length) {
      this.#dirty = true;
      this.save();
    }
  }

  /** Drop expired, superseded and lowest-value items beyond the cap. */
  prune(maxItems: number, now = Date.now()): { removed: number } {
    const before = this.items.length;
    this.items = this.items.filter((i) => !i.expiresAt || i.expiresAt > now);
    if (this.items.length > maxItems) {
      const protectedItems = this.items.filter((i) => i.pinned);
      const rest = this.items
        .filter((i) => !i.pinned)
        .sort((a, b) => {
          const ageA = now - (a.lastUsedAt ?? a.updatedAt);
          const ageB = now - (b.lastUsedAt ?? b.updatedAt);
          const scoreA = (a.hits + 1) / Math.max(1, ageA / 86_400_000);
          const scoreB = (b.hits + 1) / Math.max(1, ageB / 86_400_000);
          return scoreB - scoreA;
        });
      const keep = rest.slice(0, Math.max(0, maxItems - protectedItems.length));
      this.items = [...protectedItems, ...keep];
    }
    const removed = before - this.items.length;
    if (removed > 0) {
      this.#dirty = true;
      this.save();
    }
    return { removed };
  }

  search(query: string): MemoryItem[] {
    const q = tokenize(query);
    if (!q.length) return [...this.items];
    const idf = new Map<string, number>(q.map((t) => [t, 1]));
    const now = Date.now();
    return this.items
      .map((item) => ({ item, score: this.score(item, q, idf, now) }))
      .filter((s) => s.score > 0 || tokenize(s.item.text).some((t) => q.includes(t)))
      .sort((a, b) => b.score - a.score)
      .map((s) => s.item);
  }

  /** Compact, prompt-ready rendering of a set of memories. */
  static formatBlock(items: MemoryItem[]): string {
    if (!items.length) return "";
    const groups = new Map<MemoryKind, MemoryItem[]>();
    for (const item of items) {
      const list = groups.get(item.kind) ?? [];
      list.push(item);
      groups.set(item.kind, list);
    }
    const order: MemoryKind[] = ["preference", "decision", "fact", "entity", "task", "note"];
    const lines: string[] = [];
    for (const kind of order) {
      const list = groups.get(kind);
      if (!list?.length) continue;
      for (const item of list) {
        const pin = item.pinned ? " [pinned]" : "";
        lines.push(`- (${kind}${pin}) ${item.text}`);
      }
    }
    return lines.join("\n");
  }

  /** Merge another bank's items in, preserving ids. */
  absorb(other: MemoryBank): number {
    let added = 0;
    for (const item of other.items) {
      if (this.items.some((i) => i.hash === item.hash)) continue;
      this.items.push({ ...item, scope: this.scope });
      added++;
    }
    if (added) {
      this.#dirty = true;
      this.save();
    }
    return added;
  }

  export(): string {
    return JSON.stringify({ format: "kono-memory", version: 1, scope: this.scope, items: this.items }, null, 2);
  }

  importJson(json: string): number {
    const parsed = JSON.parse(json) as { items?: MemoryItem[] };
    if (!Array.isArray(parsed.items)) throw new Error("Not a kono memory export");
    let added = 0;
    for (const raw of parsed.items) {
      if (!raw?.text) continue;
      if (this.items.some((i) => i.hash === (raw.hash ?? hashText(raw.text)))) continue;
      this.items.push({
        id: newId("mem_"),
        text: raw.text,
        kind: raw.kind ?? "note",
        scope: this.scope,
        hash: raw.hash ?? hashText(raw.text),
        createdAt: raw.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        hits: raw.hits ?? 0,
        ...(raw.pinned ? { pinned: true } : {}),
        ...(raw.tags ? { tags: raw.tags } : {}),
        source: { kind: "import" },
      });
      added++;
    }
    if (added) {
      this.#dirty = true;
      this.save();
    }
    return added;
  }

  stats(): { total: number; pinned: number; byKind: Record<string, number>; tokens: number } {
    const byKind: Record<string, number> = {};
    let tokens = 0;
    let pinned = 0;
    for (const item of this.items) {
      byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
      tokens += estimateTokens(item.text);
      if (item.pinned) pinned++;
    }
    return { total: this.items.length, pinned, byKind, tokens };
  }
}

/** A bundle of banks queried together, in priority order. */
export class MemoryStack {
  banks: MemoryBank[];

  constructor(banks: MemoryBank[]) {
    this.banks = banks;
  }

  retrieve(query: string, opts: { topK?: number; tokenBudget?: number } = {}): MemoryItem[] {
    const topK = opts.topK ?? 8;
    const budget = opts.tokenBudget ?? 900;
    const merged: Array<{ item: MemoryItem; score: number }> = [];
    const scopeWeight: Record<MemoryScope, number> = { session: 1.25, project: 1.12, global: 1 };
    for (const bank of this.banks) {
      const picked = bank.retrieve(query, { topK: topK * 2, tokenBudget: budget * 2 });
      for (const item of picked) merged.push({ item, score: scopeWeight[bank.scope] * (item.pinned ? 2 : 1) });
    }
    merged.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const out: MemoryItem[] = [];
    let used = 0;
    for (const { item } of merged) {
      if (seen.has(item.hash)) continue;
      const cost = estimateTokens(item.text) + 6;
      if (used + cost > budget || out.length >= topK) continue;
      seen.add(item.hash);
      out.push(item);
      used += cost;
    }
    return out;
  }

  touch(items: MemoryItem[]): void {
    for (const bank of this.banks) bank.touch(items.filter((i) => i.scope === bank.scope));
  }

  all(): MemoryItem[] {
    const seen = new Set<string>();
    const out: MemoryItem[] = [];
    for (const bank of this.banks) {
      for (const item of bank.items) {
        if (seen.has(item.hash)) continue;
        seen.add(item.hash);
        out.push(item);
      }
    }
    return out.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
  }

  stats(): { total: number; pinned: number; tokens: number; banks: Array<{ scope: MemoryScope; path: string; items: number }> } {
    const banks = this.banks.map((b) => ({ scope: b.scope, path: b.path, items: b.items.length }));
    const all = this.all();
    let tokens = 0;
    for (const item of all) tokens += estimateTokens(item.text);
    return { total: all.length, pinned: all.filter((i) => i.pinned).length, tokens, banks };
  }
}

export function defaultKinds(): MemoryKind[] {
  return ["preference", "fact", "decision", "task", "entity", "note"];
}
