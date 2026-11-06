import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "../src/store/session.ts";
import { DEFAULT_CONFIG } from "../src/store/config.ts";
import type { Config } from "../src/store/config.ts";
import { buildContext, conversationWindow, defaultPersona, fallbackSummary, knownWindow, readProjectInstructions, toWireMessage } from "../src/core/context.ts";
import { MemoryBank } from "../src/store/memory.ts";

function config(patch: Partial<Config["context"]> = {}, extra: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    context: { ...DEFAULT_CONFIG.context, ...patch },
    ...extra,
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "nokey-ctx-"));
}

test("system prompt carries persona, date and runtime facts", () => {
  const home = tempDir();
  try {
    const session = Session.create({ home, model: "free:smart", cwd: home });
    session.add({ role: "user", content: "hello", parentId: null });
    const plan = buildContext({ session, config: config(), cwd: home, now: Date.UTC(2026, 10, 6) });
    assert.match(plan.system, /terminal/);
    assert.match(plan.system, /2026-11-06/);
    assert.match(plan.system, /free:smart/);
    assert.equal(plan.messages.length, 1);
    assert.equal(plan.messages[0]!.role, "user");
    assert.ok(plan.stats.totalTokens > 0);
    assert.ok(plan.stats.utilization > 0 && plan.stats.utilization <= 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("project instruction files are injected once and capped", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "NOKEY.md"), "# Rules\n- use tabs\n");
    mkdirSync(join(dir, ".nokey"), { recursive: true });
    writeFileSync(join(dir, ".nokey", "instructions.md"), "extra instructions\n");
    const docs = readProjectInstructions(dir);
    assert.match(docs, /use tabs/);
    assert.match(docs, /extra instructions/);
    const huge = readProjectInstructions(dir, 20);
    assert.ok(huge.length <= 40);

    const session = Session.create({ home: dir, model: "free:auto", cwd: dir });
    const plan = buildContext({ session, config: config(), cwd: dir });
    assert.match(plan.system, /Project instructions/);
    assert.match(plan.system, /use tabs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory block is rendered and budgeted", () => {
  const home = tempDir();
  try {
    const bank = new MemoryBank(join(home, "memory.json"), "global");
    bank.add("User prefers pnpm over npm", { kind: "preference", pinned: true });
    const session = Session.create({ home, model: "free:auto" });
    session.add({ role: "user", content: "how should I install dependencies?", parentId: null });
    const items = bank.retrieve("install dependencies pnpm", { topK: 5, tokenBudget: 400 });
    assert.ok(items.length >= 1);
    const plan = buildContext({ session, config: config(), memory: items, cwd: home });
    assert.match(plan.system, /Known memory/);
    assert.match(plan.system, /pnpm/);
    assert.ok(plan.stats.memoryTokens > 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the context window resets at the newest compaction summary", () => {
  const home = tempDir();
  try {
    const session = Session.create({ home, model: "free:auto" });
    const u1 = session.add({ role: "user", content: "old question", parentId: null });
    const a1 = session.add({ role: "assistant", content: "old answer", parentId: u1.id });
    session.add({ role: "summary", content: "Goal: ship the parser", parentId: a1.id, systemKind: "compaction", summaryOf: [u1.id, a1.id] });
    session.add({ role: "user", content: "new question", parentId: session.leafId });
    const { messages, summaries } = conversationWindow(session);
    assert.equal(summaries.length, 1);
    assert.equal(messages.length, 2, "summary + new question");
    const plan = buildContext({ session, config: config(), cwd: home });
    assert.equal(plan.messages[0]!.role, "system");
    assert.match(String(plan.messages[0]!.content), /ship the parser/);
    assert.equal(plan.messages.at(-1)!.content, "new question");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("compaction is proposed when history crosses the threshold", () => {
  const home = tempDir();
  try {
    const session = Session.create({ home, model: "free:auto" });
    let parent: string | null = null;
    for (let i = 0; i < 10; i++) {
      const turn = "x".repeat(3000);
      const user = session.add({ role: "user", content: `question ${i} ${turn}`, parentId: parent });
      const assistant = session.add({ role: "assistant", content: `answer ${i} ${turn}`, parentId: user.id });
      parent = assistant.id;
    }
    const cfg = config({ windowTokens: 8000, reserveOutputTokens: 1000, compactAt: 0.5, keepRecent: 4 });
    const plan = buildContext({ session, config: cfg, cwd: home });
    assert.equal(plan.needsCompaction, true);
    assert.ok(plan.compactable.length >= 4);
    assert.equal(plan.keep.length, 4);

    const noCompact = buildContext({ session, config: { ...cfg, context: { ...cfg.context, compaction: "off" } }, cwd: home });
    assert.equal(noCompact.needsCompaction, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a hard ceiling drops the oldest turns but keeps pinned messages and the tail", () => {
  const home = tempDir();
  try {
    const session = Session.create({ home, model: "free:auto" });
    const pinnedUser = session.add({ role: "user", content: `pinned ${"p".repeat(1500)}`, parentId: null, pinned: true });
    const pinnedAnswer = session.add({ role: "assistant", content: "noted", parentId: pinnedUser.id });
    let parent: string | null = pinnedAnswer.id;
    for (let i = 0; i < 40; i++) {
      const user = session.add({ role: "user", content: `question ${i} ${"q".repeat(800)}`, parentId: parent });
      const assistant = session.add({ role: "assistant", content: `answer ${i} ${"a".repeat(800)}`, parentId: user.id });
      parent = assistant.id;
    }
    const cfg = config({ windowTokens: 4000, reserveOutputTokens: 1000, compaction: "off" });
    const plan = buildContext({ session, config: cfg, cwd: home });
    assert.ok(plan.stats.droppedMessages > 0);
    assert.ok(plan.stats.totalTokens <= plan.stats.windowTokens);
    const contents = plan.messages.map((m) => String(m.content));
    assert.ok(contents.some((c) => c.startsWith("pinned")), "pinned message survives");
    assert.ok(contents.some((c) => c.includes("question 39")), "newest turn survives");
    assert.ok(!contents.some((c) => c.includes("question 3 ")), "old turns dropped");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("wire conversion keeps tool calls and summaries renderable", () => {
  const home = tempDir();
  try {
    const session = Session.create({ home, model: "free:auto" });
    const user = session.add({ role: "user", content: "run it", parentId: null });
    const assistant = session.add({
      role: "assistant",
      content: "calling",
      parentId: user.id,
      toolCalls: [{ id: "call_1", name: "calculate", arguments: '{"expression":"2+2"}' }],
    });
    const wire = toWireMessage(session.messages.get(assistant.id)!)!;
    assert.equal(wire.role, "assistant");
    assert.ok(Array.isArray(wire.tool_calls));
    assert.equal((wire.tool_calls![0] as { function: { name: string } }).function.name, "calculate");

    const system = session.add({ role: "system", content: "ignored", parentId: assistant.id, systemKind: "persona" });
    assert.equal(toWireMessage(session.messages.get(system.id)!), null, "the persona is not duplicated as a message");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("fallback summary is honest about its origin", () => {
  const home = tempDir();
  try {
    const session = Session.create({ home, model: "free:auto" });
    const u = session.add({ role: "user", content: "build a streaming parser with retries", parentId: null });
    session.add({ role: "assistant", content: "here is the plan", parentId: u.id });
    const text = fallbackSummary(session.path());
    assert.match(text, /Goal/);
    assert.match(text, /streaming parser/);
    assert.match(text, /summarizer unavailable/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("known window sizes and default persona are sane", () => {
  assert.equal(knownWindow("claude-sonnet-4"), 200_000);
  assert.equal(knownWindow("qwen/qwen3-coder"), 128_000);
  assert.equal(knownWindow("free:auto"), undefined);
  assert.match(defaultPersona(), /terminal/);
});
