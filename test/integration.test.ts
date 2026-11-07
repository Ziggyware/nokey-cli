import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { startMockRouter } from "./mock-router.ts";
import { RouterClient } from "../src/router/client.ts";
import type { ChatEvent } from "../src/router/client.ts";
import { SseParser } from "../src/router/sse.ts";
import { DEFAULT_CONFIG } from "../src/store/config.ts";
import type { Config } from "../src/store/config.ts";
import { Session, SessionStore } from "../src/store/session.ts";
import { MemoryBank, MemoryStack } from "../src/store/memory.ts";
import { TurnEngine } from "../src/core/engine.ts";
import type { EngineEvent } from "../src/core/engine.ts";
import { startProxy } from "../src/server/proxy.ts";
import { ConfigStore } from "../src/store/config.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "kono-int-"));
}

function config(patch: Partial<Config["context"]> = {}, memory: Partial<Config["memory"]> = {}, extra: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    context: { ...DEFAULT_CONFIG.context, ...patch },
    memory: { ...DEFAULT_CONFIG.memory, ...memory },
    ...extra,
  };
}

function makeDeps(home: string, cfg: Config) {
  const store = new SessionStore(home);
  const session = store.create({ home, model: "free:auto" });
  const globalBank = new MemoryBank(join(home, "memory.json"), "global");
  const sessionBank = new MemoryBank(join(home, "session-memory.json"), "session");
  const stack = new MemoryStack([sessionBank, globalBank]);
  return { store, session, globalBank, sessionBank, stack, cfg };
}

test("SSE parser reassembles frames split across chunks", () => {
  const parser = new SseParser();
  const first = parser.push('data: {"a":');
  assert.equal(first.events.length, 0);
  const second = parser.push('1}\n\ndata: [DONE]\n\n');
  assert.equal(second.events.length, 2);
  assert.equal(second.events[0]!.data, '{"a":1}');
  assert.equal(second.events[1]!.data, "[DONE]");
  const comments = parser.push(": routing lane=smart\n: keepalive\n");
  assert.deepEqual(comments.comments, ["routing lane=smart", "keepalive"]);
  const crlf = new SseParser();
  assert.equal(crlf.push("data: hi\r\n\r\n").events[0]!.data, "hi");
});

test("streaming client yields reasoning, content and telemetry", async () => {
  const mock = await startMockRouter({ chunkDelayMs: 0 });
  try {
    const router = new RouterClient({ baseUrl: mock.url, apiKey: "test", retries: 0 });
    let content = "";
    let reasoning = "";
    let telemetry: Record<string, unknown> = {};
    let routing = 0;
    let final: ChatEvent | undefined;
    for await (const ev of router.stream({ model: "free:smart", messages: [{ role: "user", content: "explain" }] })) {
      if (ev.type === "content") content += ev.delta;
      if (ev.type === "reasoning") reasoning += ev.delta;
      if (ev.type === "routing") routing++;
      if (ev.type === "open") telemetry = { ...telemetry, ...ev.telemetry };
      if (ev.type === "final") {
        telemetry = { ...telemetry, ...ev.telemetry };
        final = ev;
      }
    }
    assert.match(content, /streaming client/);
    assert.match(content, /```ts/);
    assert.match(reasoning, /router contract/);
    assert.ok(routing >= 1, "routing heartbeat surfaced");
    assert.ok(telemetry.ttftMs !== undefined);
    assert.ok(telemetry.totalMs !== undefined);
    assert.equal(final?.type, "final");
    const t = (final as unknown as { telemetry: Record<string, unknown> }).telemetry;
    assert.ok(t.traceId);
    assert.equal(t.attempts, 1);
  } finally {
    await mock.close();
  }
});

test("non-streaming completion parses buffered JSON and telemetry", async () => {
  const mock = await startMockRouter();
  try {
    const router = new RouterClient({ baseUrl: mock.url, apiKey: "test", retries: 0 });
    const { text, telemetry } = await router.complete({ model: "free:auto", messages: [{ role: "user", content: "hi" }] });
    assert.match(text, /minimal streaming client/);
    assert.equal(telemetry.attempts, 1);
    assert.equal(telemetry.endpoints, 2, "the router's nokey object is parsed");
    assert.equal(telemetry.model, "free:auto");
    assert.ok(telemetry.ttftMs !== undefined, "server-timing is parsed");
  } finally {
    await mock.close();
  }
});

test("429 is retried with backoff and then succeeds", async () => {
  const mock = await startMockRouter({ rateLimitFirst: 1 });
  try {
    const router = new RouterClient({ baseUrl: mock.url, apiKey: "test", retries: 2 });
    let content = "";
    let failed = false;
    for await (const ev of router.stream({ messages: [{ role: "user", content: "retry please" }] })) {
      if (ev.type === "content") content += ev.delta;
      if (ev.type === "error") failed = true;
    }
    assert.equal(failed, false);
    assert.match(content, /streaming client/);
    const chatCalls = mock.requests.filter((r) => r.path.includes("chat/completions"));
    assert.equal(chatCalls.length, 2, "one 429 then one success");
  } finally {
    await mock.close();
  }
});

test("401 is not retried and surfaces a helpful message", async () => {
  const mock = await startMockRouter();
  try {
    const router = new RouterClient({ baseUrl: mock.url, apiKey: "bad", retries: 2 });
    let error: { status?: number; message: string } | null = null;
    let content = "";
    for await (const ev of router.stream({ messages: [{ role: "user", content: "__401__" }] })) {
      if (ev.type === "content") content += ev.delta;
      if (ev.type === "error") error = { status: ev.error.status, message: ev.error.message };
    }
    assert.ok(error);
    assert.equal(error!.status, 401);
    assert.match(error!.message, /401/);
    assert.match(error!.message, /key/i);
    assert.equal(content, "");
    assert.equal(mock.requests.filter((r) => r.path.includes("chat/completions")).length, 1, "no retry on 401");
  } finally {
    await mock.close();
  }
});

test("aborting mid-stream keeps what arrived and reports the abort", async () => {
  const mock = await startMockRouter({ chunkDelayMs: 30 });
  try {
    const router = new RouterClient({ baseUrl: mock.url, apiKey: "test", retries: 0 });
    const controller = new AbortController();
    let content = "";
    let aborted = false;
    let sawContent = 0;
    for await (const ev of router.stream({ messages: [{ role: "user", content: "long answer" }] }, controller.signal)) {
      if (ev.type === "content") {
        content += ev.delta;
        sawContent++;
        if (sawContent === 3) controller.abort(new Error("user aborted"));
      }
      if (ev.type === "final") aborted = true;
    }
    assert.ok(content.length > 0, "partial content preserved");
    assert.equal(aborted, true);
  } finally {
    await mock.close();
  }
});

test("degraded header is surfaced", async () => {
  const mock = await startMockRouter({ degraded: true });
  try {
    const router = new RouterClient({ baseUrl: mock.url, apiKey: "test", retries: 0 });
    let degraded = false;
    for await (const ev of router.stream({ messages: [{ role: "user", content: "hi" }] })) {
      if (ev.type === "degraded") degraded = true;
    }
    assert.equal(degraded, true);
  } finally {
    await mock.close();
  }
});

test("engine persists the turn, telemetry and learned memory", async () => {
  const home = tempHome();
  const mock = await startMockRouter();
  try {
    const deps = makeDeps(home, config({}, { extract: "heuristic" }));
    const router = new RouterClient({ baseUrl: mock.url, apiKey: "test", retries: 0 });
    const engine = new TurnEngine({
      session: deps.session,
      router,
      config: deps.cfg,
      memory: deps.stack,
      autoBank: deps.globalBank,
      sessionBank: deps.sessionBank,
      cwd: home,
    });

    const events: EngineEvent[] = [];
    for await (const ev of engine.send("I prefer pnpm over npm for installs. How do I stream from the router?")) events.push(ev);

    const kinds = new Set(events.map((e) => e.type));
    assert.ok(kinds.has("start"));
    assert.ok(kinds.has("delta"));
    assert.ok(kinds.has("telemetry"));
    assert.ok(kinds.has("done"));

    const done = events.find((e) => e.type === "done") as Extract<EngineEvent, { type: "done" }>;
    assert.match(done.message.content, /streaming client/);
    assert.ok(done.message.telemetry?.totalMs !== undefined);
    assert.ok(done.message.telemetry?.promptTokens, "prompt tokens recorded");
    assert.equal(done.message.role, "assistant");

    // Persisted and reloadable.
    const reloaded = deps.store.load(deps.session.id);
    assert.equal(reloaded!.path().length, 2);
    assert.match(reloaded!.path().at(-1)!.content, /streaming client/);
    assert.match(reloaded!.meta.title, /^I prefer pnpm over npm/);
    assert.ok(reloaded!.meta.title.length <= 65);

    // Memory learned from the user turn.
    const learned = deps.globalBank.items.map((i) => i.text.toLowerCase());
    assert.ok(learned.some((t) => t.includes("pnpm")), `expected a pnpm memory, got ${JSON.stringify(learned)}`);
    assert.ok(events.some((e) => e.type === "memory"));
  } finally {
    await mock.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("engine records tool-call deltas when tools are enabled", async () => {
  const home = tempHome();
  const mock = await startMockRouter();
  try {
    const deps = makeDeps(home, config({}, { extract: "off" }));
    const router = new RouterClient({ baseUrl: mock.url, apiKey: "test", retries: 0 });
    const engine = new TurnEngine({
      session: deps.session,
      router,
      config: deps.cfg,
      memory: deps.stack,
      autoBank: deps.globalBank,
      cwd: home,
    });
    let message;
    for await (const ev of engine.send("calculate 2+2", { tools: true })) {
      if (ev.type === "done") message = ev.message;
    }
    const calls = message?.toolCalls ?? [];
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, "calculate");
    assert.equal(calls[0]!.arguments, '{"expression":"2+2"}');
  } finally {
    await mock.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("engine compacts when the window fills and keeps working", async () => {
  const home = tempHome();
  const mock = await startMockRouter();
  try {
    const deps = makeDeps(home, config({ windowTokens: 3000, reserveOutputTokens: 800, compactAt: 0.3, keepRecent: 2, compaction: "auto" }, { extract: "off" }));
    const router = new RouterClient({ baseUrl: mock.url, apiKey: "test", retries: 0 });
    const engine = new TurnEngine({
      session: deps.session,
      router,
      config: deps.cfg,
      memory: deps.stack,
      autoBank: deps.globalBank,
      cwd: home,
    });
    let compacted = false;
    for (let i = 0; i < 5; i++) {
      for await (const ev of engine.send(`turn ${i}: explain streaming clients in depth`)) {
        if (ev.type === "compacted") compacted = true;
      }
    }
    assert.equal(compacted, true, "compaction fired");
    const summaries = deps.session.path().filter((m) => m.role === "summary");
    assert.equal(summaries.length, 1);
    assert.ok(summaries[0]!.summaryOf!.length >= 2);
    assert.equal(deps.session.meta.compactions?.length, 1);
    // The summary is reloadable and the context builder starts from it.
    const reloaded = deps.store.load(deps.session.id);
    assert.equal(reloaded!.path().filter((m) => m.role === "summary").length, 1);
  } finally {
    await mock.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("retry forks a sibling branch instead of overwriting", async () => {
  const home = tempHome();
  const mock = await startMockRouter();
  try {
    const deps = makeDeps(home, config({}, { extract: "off" }));
    const router = new RouterClient({ baseUrl: mock.url, apiKey: "test", retries: 0 });
    const engine = new TurnEngine({
      session: deps.session,
      router,
      config: deps.cfg,
      memory: deps.stack,
      autoBank: deps.globalBank,
      cwd: home,
    });
    for await (const _ of engine.send("first question")) void _;
    const firstPath = deps.session.path().map((m) => m.id);
    for await (const _ of engine.retry()) void _;
    const secondPath = deps.session.path().map((m) => m.id);
    assert.equal(secondPath.length, firstPath.length);
    assert.notEqual(secondPath.at(-1), firstPath.at(-1), "a new sibling answer");
    assert.equal(deps.session.messages.size, 3, "both answers kept in the tree");
    assert.equal(deps.session.siblings(firstPath.at(-1)!).length, 2);
  } finally {
    await mock.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("proxy forwards streams, injects the key and sets CORS", async () => {
  const mock = await startMockRouter();
  const home = tempHome();
  try {
    const configStore = new ConfigStore(home, {} as NodeJS.ProcessEnv);
    configStore.value.router.apiKey = "injected-key";
    const router = new RouterClient({ baseUrl: mock.url, retries: 0 });
    const proxy = await startProxy({ router, config: configStore, port: 0, host: "127.0.0.1" });
    try {
      const models = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`);
      assert.equal(models.status, 200);
      assert.equal(models.headers.get("access-control-allow-origin"), "*");
      const body = (await models.json()) as { data: unknown[] };
      assert.ok(body.data.length >= 3);

      const stream = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "free:auto", stream: true, messages: [{ role: "user", content: "__short__" }] }),
      });
      assert.match(stream.headers.get("content-type") ?? "", /event-stream/);
      const text = await stream.text();
      assert.match(text, /data: /);
      assert.match(text, /\[DONE\]/);

      const preflight = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`, { method: "OPTIONS" });
      assert.equal(preflight.status, 204);
      const landing = await fetch(`http://127.0.0.1:${proxy.port}/`);
      assert.match(await landing.text(), /Local gateway/);
    } finally {
      proxy.close();
    }
  } finally {
    await mock.close();
    rmSync(home, { recursive: true, force: true });
  }
});

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const repoRoot = new URL("..", import.meta.url).pathname;
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", join(repoRoot, "src", "cli.ts"), ...args], {
      cwd: cwd ?? repoRoot,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test("CLI print mode streams an answer and records a session", async () => {
  const mock = await startMockRouter();
  const home = tempHome();
  try {
    const env = { KONO_HOME: home, KONO_BASE_URL: mock.url, KONO_API_KEY: "test-key", KONO_COLOR: "none" };
    const result = await runCli(["-p", "explain the router briefly"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /streaming client/);
    assert.match(result.stderr, /ttft/);

    const json = await runCli(["-p", "explain again", "--json"], env);
    const parsed = JSON.parse(json.stdout) as { content: string; telemetry: Record<string, unknown>; sessionId: string };
    assert.match(parsed.content, /streaming client/);
    assert.ok(parsed.sessionId.startsWith("s_"));

    const list = await runCli(["sessions", "list"], env);
    const titles = list.stdout.split("\n").filter((line) => line.includes("explain"));
    assert.equal(titles.length, 2, `expected both sessions, got:\n${list.stdout}`);
  } finally {
    await mock.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI reports auth failures with an actionable message", async () => {
  const mock = await startMockRouter();
  const home = tempHome();
  try {
    const result = await runCli(["-p", "__401__"], { KONO_HOME: home, KONO_BASE_URL: mock.url, KONO_API_KEY: "bad", KONO_COLOR: "none" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /401|Unauthorized|ROUTER_API_KEY/);
  } finally {
    await mock.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI + memory + sessions utilities work end to end", async () => {
  const home = tempHome();
  const project = tempHome();
  try {
    const env = { KONO_HOME: home, KONO_COLOR: "none", KONO_BASE_URL: "http://127.0.0.1:1" };

    // init writes into the *project* directory, never the CLI's own repo.
    const init = await runCli(["init"], env, project);
    assert.equal(init.code, 0, init.stderr);
    assert.match(init.stdout, /KONO\.md/);
    assert.ok(existsSync(join(project, "KONO.md")));

    const add = await runCli(["memory", "add", "Always use TypeScript strict mode"], env, project);
    assert.equal(add.code, 0, add.stderr);
    assert.match(add.stdout, /added/);

    const list = await runCli(["memory", "list"], env, project);
    assert.match(list.stdout, /TypeScript strict mode/);

    const stats = await runCli(["memory", "stats"], env, project);
    assert.match(stats.stdout, /1 items/);

    const cfgPath = await runCli(["config", "path"], env, project);
    assert.match(cfgPath.stdout, /config\.json/);

    const doctor = await runCli(["doctor"], env, project);
    assert.match(doctor.stdout, /api key/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
