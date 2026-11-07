import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session, SessionStore, deriveTitle } from "../src/store/session.ts";
import { MemoryBank, MemoryStack, hashText, jaccard, tokenize } from "../src/store/memory.ts";
import { extractHeuristic, contradictions, novel } from "../src/core/memory-extract.ts";
import { ConfigStore, DEFAULT_CONFIG, mergeConfig } from "../src/store/config.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "kono-test-"));
}

test("sessions persist, reload and preserve the active path", () => {
  const home = tempHome();
  try {
    const store = new SessionStore(home);
    const session = store.create({ home, model: "free:auto", cwd: "/tmp/project" });
    const user = session.add({ role: "user", content: "hello there", parentId: null });
    session.add({ role: "assistant", content: "hi", parentId: user.id });
    session.autotitle();

    const reloaded = store.load(session.id);
    assert.ok(reloaded);
    assert.equal(reloaded!.path().length, 2);
    assert.equal(reloaded!.path()[0]!.content, "hello there");
    assert.equal(reloaded!.meta.title, "hello there");
    assert.equal(reloaded!.meta.messageCount, 2);
    assert.ok(reloaded!.meta.tokens > 0);

    const listed = store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, session.id);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("editing creates siblings instead of destroying history", () => {
  const home = tempHome();
  try {
    const session = Session.create({ home, model: "free:auto" });
    const u1 = session.add({ role: "user", content: "first", parentId: null });
    const a1 = session.add({ role: "assistant", content: "answer one", parentId: u1.id });

    // Regenerate: same parent, new sibling.
    session.setLeaf(u1.id);
    const a2 = session.add({ role: "assistant", content: "answer two", parentId: u1.id });

    assert.deepEqual(session.siblings(a1.id).sort(), [a1.id, a2.id].sort());
    assert.equal(session.path().length, 2, "only the active branch is materialised");
    assert.equal(session.path()[1]!.content, "answer two");

    session.setLeaf(a1.id);
    assert.equal(session.path()[1]!.content, "answer one");
    assert.equal(session.leaves().length, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("hiding a message retreats the leaf to a visible ancestor", () => {
  const home = tempHome();
  try {
    const session = Session.create({ home, model: "free:auto" });
    const u1 = session.add({ role: "user", content: "q", parentId: null });
    const a1 = session.add({ role: "assistant", content: "a", parentId: u1.id });
    session.hide(a1.id);
    assert.equal(session.leafId, u1.id);
    assert.equal(session.path().length, 1);
    session.hide(u1.id);
    assert.equal(session.leafId, null);
    assert.equal(session.path().length, 0);
    // The tombstone stays in the log for auditability.
    const events = readFileSync(join(session.dir, "events.jsonl"), "utf8");
    assert.match(events, /"t":"hide"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a torn final log line is tolerated on load", () => {
  const home = tempHome();
  try {
    const session = Session.create({ home, model: "free:auto" });
    session.add({ role: "user", content: "hello", parentId: null });
    const eventsPath = join(session.dir, "events.jsonl");
    const raw = readFileSync(eventsPath, "utf8");
    writeFileSync(eventsPath, raw + '{"t":"message","ts":1,"msg":{"id":"trunc');
    const reloaded = Session.load(home, session.id);
    assert.ok(reloaded);
    assert.equal(reloaded!.path().length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("compaction records a summary node in the tree", () => {
  const home = tempHome();
  try {
    const session = Session.create({ home, model: "free:auto" });
    const u1 = session.add({ role: "user", content: "long discussion", parentId: null });
    const a1 = session.add({ role: "assistant", content: "reply", parentId: u1.id });
    const summary = session.add({ role: "summary", content: "## Goal\nShip it", parentId: a1.id, summaryOf: [u1.id, a1.id], systemKind: "compaction" });
    session.recordCompaction(summary.id, [u1.id, a1.id]);
    const reloaded = Session.load(home, session.id);
    assert.equal(reloaded!.meta.compactions?.[0], summary.id);
    assert.equal(reloaded!.path().at(-1)!.role, "summary");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("export/import round-trips a session with its tree", () => {
  const home = tempHome();
  try {
    const store = new SessionStore(home);
    const session = store.create({ home, model: "free:smart" });
    const u1 = session.add({ role: "user", content: "hello", parentId: null });
    session.add({ role: "assistant", content: "world", parentId: u1.id });
    session.rename("Exported");
    const json = store.exportJson(session);
    const imported = store.importJson(json);
    assert.notEqual(imported.meta.id, session.id);
    assert.equal(imported.meta.title, "Exported");
    assert.equal(imported.path().length, 2);
    assert.equal(store.list().length, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("search finds snippets across sessions", () => {
  const home = tempHome();
  try {
    const store = new SessionStore(home);
    const a = store.create({ home, model: "m" });
    a.add({ role: "user", content: "the router uses Bayesian lane scoring", parentId: null });
    const b = store.create({ home, model: "m" });
    b.add({ role: "user", content: "unrelated content", parentId: null });
    const hits = store.search("bayesian");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.sessionId, a.id);
    assert.match(hits[0]!.snippet.toLowerCase(), /bayesian/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("deriveTitle trims code fences and length", () => {
  assert.equal(deriveTitle("```js\ncode\n```\nExplain the router please"), "Explain the router please");
  assert.ok(deriveTitle("x".repeat(200)).length <= 65);
});

test("memory dedupes, merges near-duplicates and reports actions", () => {
  const home = tempHome();
  try {
    const bank = new MemoryBank(join(home, "memory.json"), "global");
    const first = bank.add("I prefer pnpm over npm", { kind: "preference" });
    assert.equal(first.action, "added");
    const again = bank.add("I prefer pnpm over npm");
    assert.equal(again.action, "duplicate");
    assert.equal(again.item.id, first.item.id);
    const near = bank.add("I prefer pnpm over npm for installs");
    assert.equal(near.action, "merged");
    assert.equal(bank.items.length, 1);
    assert.match(bank.items[0]!.text, /installs/);
    assert.ok(hashText("Same  Text!") === hashText("same text"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("memory retrieval ranks relevance and honours pins and budgets", () => {
  const home = tempHome();
  try {
    const bank = new MemoryBank(join(home, "memory.json"), "global");
    bank.add("The deploy target is Fly.io in the eu-west region", { kind: "fact" });
    bank.add("User prefers dark neon themes", { kind: "preference", pinned: true });
    bank.add("Unrelated note about sourdough starters", { kind: "note" });

    const hits = bank.retrieve("how do I deploy to production?", { topK: 3, tokenBudget: 500 });
    assert.ok(hits.length >= 1);
    assert.match(hits[0]!.text, /deploy|Fly\.io/);
    // Pinned items always survive the filter.
    assert.ok(hits.some((h) => h.pinned));

    const tight = bank.retrieve("deploy", { topK: 5, tokenBudget: 12 });
    assert.ok(tight.length <= 1, "token budget is respected");

    const nothing = bank.retrieve("quantum chromodynamics", { topK: 5 });
    assert.ok(nothing.every((h) => h.pinned), "irrelevant memories are not injected");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("memory prune keeps pinned items and drops the stalest", () => {
  const home = tempHome();
  try {
    const bank = new MemoryBank(join(home, "memory.json"), "global");
    const topics = ["deployment", "styling", "parsing", "telemetry", "routing", "memory", "sessions", "compaction", "themes", "tokens", "retries", "keyboards"];
    for (const topic of topics) bank.add(`Something durable about ${topic} and its tradeoffs`, { kind: "fact" });
    const pinned = bank.add("pinned forever", { kind: "note", pinned: true }).item;
    assert.equal(bank.items.length, 13);
    bank.prune(5);
    assert.ok(bank.items.length <= 5);
    assert.ok(bank.items.some((i) => i.id === pinned.id));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("memory stack merges scopes and de-duplicates by hash", () => {
  const home = tempHome();
  try {
    const global = new MemoryBank(join(home, "global.json"), "global");
    const project = new MemoryBank(join(home, "project.json"), "project");
    const session = new MemoryBank(join(home, "session.json"), "session");
    global.add("Use tabs", { kind: "preference" });
    project.add("Use tabs", { kind: "preference" });
    project.add("The API runs on port 8787", { kind: "fact" });
    session.add("Currently debugging the SSE parser", { kind: "task" });
    const stack = new MemoryStack([session, project, global]);
    const hits = stack.retrieve("tabs port api sse", { topK: 10, tokenBudget: 2000 });
    assert.equal(hits.filter((h) => h.text === "Use tabs").length, 1, "deduped across banks");
    assert.ok(hits.some((h) => /8787/.test(h.text)));
    assert.equal(stack.stats().banks.length, 3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("heuristic extraction catches preferences, decisions and identity", () => {
  const prefs = extractHeuristic("I prefer pnpm over npm for everything. Also please always use TypeScript strict mode.");
  assert.ok(prefs.some((p) => p.kind === "preference" && /pnpm/.test(p.text)));
  assert.ok(prefs.some((p) => /TypeScript/.test(p.text)));

  const decisions = extractHeuristic("We decided to move the ingestion pipeline to Deno Deploy.");
  assert.ok(decisions.some((d) => d.kind === "decision"));

  const identity = extractHeuristic("Hi! My name is Ada and I work on compiler tooling.");
  assert.ok(identity.some((i) => i.kind === "entity" && /Ada/.test(i.text)));

  const explicit = extractHeuristic("Remember that the staging database is read-only.");
  assert.ok(explicit.some((p) => p.kind === "note" && /staging database/.test(p.text)));

  // Questions and noise must not become memories.
  assert.equal(extractHeuristic("What is the capital of France?").length, 0);
  assert.equal(extractHeuristic("thanks!").length, 0);
});

test("novel and contradictions gate what gets stored", () => {
  const home = tempHome();
  try {
    const bank = new MemoryBank(join(home, "m.json"), "global");
    const existing = bank.add("Always use tabs for indentation", { kind: "preference" }).item;
    const dup = extractHeuristic("Please always use tabs for indentation.");
    assert.equal(novel(dup, bank.items).length, 0);

    const opposite = extractHeuristic("Never use tabs, spaces only.")[0]!;
    const conflicts = contradictions(opposite, bank.items);
    assert.ok(conflicts.some((c) => c.id === existing.id));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config: defaults, merge, coercion and dot-path set", () => {
  const home = tempHome();
  try {
    const store = new ConfigStore(home, {} as NodeJS.ProcessEnv);
    assert.equal(store.value.router.baseUrl, DEFAULT_CONFIG.router.baseUrl);
    assert.equal(store.value.ui.theme, "midnight");

    store.set("ui.theme", "aurora");
    store.set("context.windowTokens", "32000");
    store.set("memory.enabled", "false");
    assert.equal(store.value.ui.theme, "aurora");
    assert.equal(store.value.context.windowTokens, 32000);
    assert.equal(store.value.memory.enabled, false);

    const reloaded = new ConfigStore(home, {} as NodeJS.ProcessEnv);
    assert.equal(reloaded.value.ui.theme, "aurora");
    assert.equal(reloaded.value.memory.enabled, false);

    assert.throws(() => store.set("ui.nope", "x"), /Unknown setting/);
    assert.throws(() => store.set("memory.enabled", "maybe"), /boolean/);

    // Unknown sections are ignored and invalid values coerced.
    const merged = mergeConfig(DEFAULT_CONFIG, { ui: { theme: "not-a-theme", lineNumbers: false }, bogus: { x: 1 } });
    assert.equal(merged.ui.theme, "midnight");
    assert.equal(merged.ui.lineNumbers, false);
    assert.equal(merged.context.windowTokens, DEFAULT_CONFIG.context.windowTokens);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config file is created with restrictive permissions", () => {
  const home = tempHome();
  try {
    const store = new ConfigStore(home, {} as NodeJS.ProcessEnv);
    store.save();
    assert.ok(existsSync(store.path));
    const mode = statSync(store.path).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(store.maskKey(), "");
    store.value.router.apiKey = "nok_livekey_abcdef123456";
    assert.match(store.maskKey(), /^nok_…3456$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("tokenize and jaccard are stable helpers", () => {
  assert.deepEqual(tokenize("The runners are running"), ["runner", "run"]);
  assert.equal(jaccard(["a", "b"], ["a", "b"]), 1);
  assert.equal(jaccard(["a"], ["b"]), 0);
});
