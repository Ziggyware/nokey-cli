#!/usr/bin/env node
/**
 * Entry point.
 *
 * Two personalities: an interactive TUI (`kono`) and a scriptable printer
 * (`kono -p "…"`, `kono models --json`) that shares the same engine, memory
 * bank and session log. Everything is reachable without a subcommand
 * (`kono sessions`, `kono memory`, `kono proxy`) for use in Makefiles.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import process from "node:process";
import { RouterClient, catalogModels } from "./router/client.ts";
import { ConfigStore } from "./store/config.ts";
import { SessionStore } from "./store/session.ts";
import type { Session } from "./store/session.ts";
import { MemoryBank, MemoryStack } from "./store/memory.ts";
import { ensureDir } from "./util/fsx.ts";
import { paths, projectMemoryPath, resolveHome, sessionDir } from "./store/paths.ts";
import { TurnEngine } from "./core/engine.ts";
import { explainError } from "./core/engine.ts";
import { App } from "./ui/app.ts";
import { detectColorMode } from "./util/ansi.ts";
import { getTheme } from "./ui/theme.ts";
import { renderMarkdown } from "./render/markdown-render.ts";
import { lineToAnsi } from "./util/ansi.ts";
import { startProxy } from "./server/proxy.ts";
import { fmtDuration } from "./util/time.ts";
import { fmtTokens } from "./util/tokens.ts";
import { safeFileName } from "./util/fsx.ts";
import { VERSION, HELP_TEXT, HOSTED_GATEWAY } from "./version.ts";

const VALUE_FLAGS = new Set([
  "model",
  "session",
  "home",
  "key",
  "base",
  "theme",
  "system",
  "temperature",
  "max-tokens",
  "port",
  "host",
  "print",
  "p",
  "title",
]);

interface ParsedArgs {
  command: string;
  rest: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (VALUE_FLAGS.has(body) && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("-")) {
        flags[body] = argv[++i]!;
        continue;
      }
      flags[body] = true;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const body = arg.slice(1);
      if (VALUE_FLAGS.has(body) && argv[i + 1] !== undefined) {
        flags[body] = argv[++i]!;
        continue;
      }
      flags[body] = true;
      continue;
    }
    positional.push(arg);
  }
  const command = positional[0] ?? "";
  return { command, rest: positional.slice(1), flags };
}

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === "true" || flags[name] === "1";
}

function fail(message: string, code = 1): never {
  process.stderr.write(`kono: ${message}\n`);
  process.exit(code);
}

function buildRouter(configStore: ConfigStore): RouterClient {
  const cfg = configStore.value;
  return new RouterClient({
    baseUrl: cfg.router.baseUrl,
    apiKey: cfg.router.apiKey,
    adminSecret: cfg.router.adminSecret,
    timeoutMs: cfg.router.timeoutMs,
    idleMs: cfg.router.idleMs,
    retries: cfg.router.retries,
  });
}

function pickAutoBank(home: string, configStore: ConfigStore, cwd: string): MemoryBank {
  const isRepo = existsSync(join(cwd, ".git")) || existsSync(join(cwd, ".kono"));
  const stats = configStore.value.memory;
  if (stats.useProjectMemory && isRepo) {
    return new MemoryBank(projectMemoryPath(cwd), "project", { halfLifeDays: stats.halfLifeDays });
  }
  return new MemoryBank(paths(home).memory, "global", { halfLifeDays: stats.halfLifeDays });
}

function buildMemoryStack(home: string, session: Session, configStore: ConfigStore, cwd: string): { stack: MemoryStack; sessionBank: MemoryBank; autoBank: MemoryBank } {
  const cfg = configStore.value.memory;
  const globalBank = new MemoryBank(paths(home).memory, "global", { halfLifeDays: cfg.halfLifeDays });
  const banks: MemoryBank[] = [globalBank];
  if (cfg.useProjectMemory) {
    const projectPath = projectMemoryPath(cwd);
    if (existsSync(projectPath) || existsSync(join(cwd, ".git"))) {
      banks.push(new MemoryBank(projectPath, "project", { halfLifeDays: cfg.halfLifeDays }));
    }
  }
  const sessionBank = new MemoryBank(join(sessionDir(home, session.meta.id), "memory.json"), "session", { halfLifeDays: cfg.halfLifeDays });
  banks.unshift(sessionBank);
  const stack = new MemoryStack(banks);
  const autoBank = pickAutoBank(home, configStore, cwd);
  return { stack, sessionBank, autoBank };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { command, rest, flags } = parseArgs(argv);

  if (flagBool(flags, "help") && !command) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  if (flagBool(flags, "version")) {
    process.stdout.write(`kono ${VERSION}\n`);
    return;
  }
  if (command === "help") {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  if (command === "version") {
    process.stdout.write(`kono ${VERSION}\n`);
    return;
  }

  const home = resolveHome(flagString(flags, "home") ? { ...process.env, KONO_HOME: flagString(flags, "home")! } : process.env);
  ensureDir(home);
  const configStore = new ConfigStore(home);
  if (flagString(flags, "key")) configStore.value.router.apiKey = flagString(flags, "key")!;
  if (flagString(flags, "base")) configStore.value.router.baseUrl = flagString(flags, "base")!;
  if (flagString(flags, "model")) configStore.value.model.default = flagString(flags, "model")!;
  if (flagString(flags, "theme")) configStore.value.ui.theme = flagString(flags, "theme")!;
  if (flagBool(flags, "no-color")) configStore.value.ui.colorMode = "none";

  const router = buildRouter(configStore);
  const store = new SessionStore(home);
  const cwd = process.cwd();

  switch (command) {
    case "config":
      return configCommand(configStore, rest);
    case "sessions":
    case "session":
      return sessionsCommand(store, rest, flags);
    case "memory":
      return memoryCommand(home, store, configStore, rest, cwd);
    case "models":
      return modelsCommand(router, flagBool(flags, "json"));
    case "tools":
      return toolsCommand(router, rest, flagBool(flags, "json"));
    case "doctor":
      return doctorCommand(configStore, router, store);
    case "gateway":
      return gatewayCommand();
    case "proxy":
      return proxyCommand(configStore, router, flags);
    case "export":
      return exportCommand(store, rest);
    case "init":
      return initCommand();
    default:
      break;
  }

  // Print mode: explicit prompt, or stdin piped in.
  const printPrompt = flagString(flags, "print") ?? flagString(flags, "p") ?? (command && command !== "chat" && command !== "ask" ? argv.filter((a) => !a.startsWith("-")).join(" ") : "");
  const wantsPrint = printPrompt !== "" || !process.stdin.isTTY;
  if (wantsPrint) {
    const prompt = printPrompt || (await readStdin()).trim();
    if (!prompt) fail("no prompt provided");
    return printMode(prompt, { configStore, router, store, home, flags, cwd });
  }

  return interactive({ configStore, router, store, home, flags, cwd });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

interface Ctx {
  configStore: ConfigStore;
  router: RouterClient;
  store: SessionStore;
  home: string;
  flags: Record<string, string | boolean>;
  cwd: string;
}

function resolveSession(ctx: Ctx): Session {
  const requested = flagString(ctx.flags, "session");
  if (requested) {
    const session = ctx.store.load(requested) ?? ctx.store.list().find((s) => s.id.startsWith(requested)) ? null : null;
    const byPrefix = session ?? (() => {
      const hit = ctx.store.list().find((s) => s.id.startsWith(requested));
      return hit ? ctx.store.load(hit.id) : null;
    })();
    if (byPrefix) return byPrefix;
    fail(`no session matching "${requested}"`);
  }
  if (flagBool(ctx.flags, "continue") || flagBool(ctx.flags, "c") || ctx.configStore.value.session.resumeLast) {
    const latest = ctx.store.latest();
    if (latest && latest.meta.messageCount > 0) return latest;
  }
  return ctx.store.create({
    home: ctx.home,
    model: ctx.configStore.value.model.default,
    cwd: ctx.cwd,
  });
}

function makeEngine(ctx: Ctx, session: Session, stack: MemoryStack, sessionBank: MemoryBank, autoBank: MemoryBank): TurnEngine {
  return new TurnEngine({
    session,
    router: ctx.router,
    config: ctx.configStore.value,
    memory: stack,
    autoBank,
    sessionBank,
    cwd: ctx.cwd,
  });
}

async function interactive(ctx: Ctx): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    fail("interactive mode needs a TTY. Use `kono -p \"prompt\"` for scripts.");
  }
  const session = resolveSession(ctx);
  const { stack, sessionBank, autoBank } = buildMemoryStack(ctx.home, session, ctx.configStore, ctx.cwd);
  const engine = makeEngine(ctx, session, stack, sessionBank, autoBank);
  const app = new App({
    configStore: ctx.configStore,
    router: ctx.router,
    store: ctx.store,
    session,
    engine,
    memory: stack,
    autoBank,
    sessionBank,
    makeEngine: (next) => makeEngine(ctx, next, buildMemoryStack(ctx.home, next, ctx.configStore, ctx.cwd).stack, sessionBank, autoBank),
  });

  if (!ctx.router.hasKey) {
    app.notice("no API key yet — run /key <ROUTER_API_KEY> or export KONO_API_KEY", "warn", 12000);
  }
  await app.run();
}

interface PrintOptions extends Ctx {}

async function printMode(prompt: string, ctx: PrintOptions): Promise<void> {
  const session = ctx.store.create({ home: ctx.home, model: ctx.configStore.value.model.default, cwd: ctx.cwd });
  const { stack, sessionBank, autoBank } = buildMemoryStack(ctx.home, session, ctx.configStore, ctx.cwd);
  const engine = makeEngine(ctx, session, stack, sessionBank, autoBank);
  const colorMode = flagBool(ctx.flags, "no-color") ? "none" : detectColorMode(process.env, process.stdout.isTTY === true);
  const theme = getTheme(ctx.configStore.value.ui.theme);
  const showReasoning = flagBool(ctx.flags, "reasoning") || flagBool(ctx.flags, "show-reasoning");
  const json = flagBool(ctx.flags, "json");
  let content = "";
  let reasoning = "";
  let exitCode = 0;
  let finalTelemetry: Record<string, unknown> = {};

  process.stdout.write("");
  for await (const ev of engine.send(prompt, {
    ...(flagString(ctx.flags, "model") ? { model: flagString(ctx.flags, "model")! } : {}),
    ...(flagString(ctx.flags, "system") ? { extraSystem: flagString(ctx.flags, "system")! } : {}),
    ...(flagString(ctx.flags, "temperature") ? { temperature: Number(flagString(ctx.flags, "temperature")) } : {}),
    ...(flagString(ctx.flags, "max-tokens") ? { maxTokens: Number(flagString(ctx.flags, "max-tokens")) } : {}),
    ...(flagBool(ctx.flags, "tools") ? { tools: true } : {}),
  })) {
    switch (ev.type) {
      case "delta":
        content += ev.delta;
        if (!json) process.stdout.write(ev.delta);
        break;
      case "reasoning":
        reasoning += ev.delta;
        if (showReasoning && !json) process.stderr.write(ev.delta);
        break;
      case "routing":
        if (process.env.KONO_DEBUG) process.stderr.write(`\n[routing] ${ev.message}\n`);
        break;
      case "tool":
        if (process.env.KONO_DEBUG) process.stderr.write(`\n[tool] ${ev.call.name} ${ev.call.arguments.slice(0, 200)}\n`);
        break;
      case "done":
        finalTelemetry = {
          ...(ev.message.telemetry ?? {}),
          context: ev.stats.totalTokens,
        };
        break;
      case "error": {
        const info = explainError(ev.error);
        process.stderr.write(`\nkono: ${info.message}${info.hint ? `\n       ${info.hint}` : ""}\n`);
        exitCode = 1;
        break;
      }
      default:
        break;
    }
  }

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          content,
          reasoning: reasoning || undefined,
          model: ctx.configStore.value.model.default,
          telemetry: finalTelemetry,
          sessionId: session.meta.id,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write("\n");
    if (!flagBool(ctx.flags, "quiet")) {
      const tel = finalTelemetry as { ttftMs?: number; totalMs?: number; tokensPerSec?: number; attempts?: number; traceId?: string };
      const bits: string[] = [];
      if (tel.ttftMs !== undefined) bits.push(`ttft ${fmtDuration(tel.ttftMs)}`);
      if (tel.totalMs !== undefined) bits.push(`total ${fmtDuration(tel.totalMs)}`);
      if (tel.tokensPerSec) bits.push(`${tel.tokensPerSec.toFixed(1)} tok/s`);
      if (tel.attempts !== undefined) bits.push(`${tel.attempts} attempts`);
      if (tel.traceId) bits.push(`trace ${tel.traceId.slice(0, 8)}`);
      process.stderr.write(`${bits.join(" · ")}\n`);
    }
    void theme;
    void colorMode;
  }
  if (exitCode) process.exitCode = exitCode;
}

function configCommand(configStore: ConfigStore, rest: string[]): void {
  const sub = rest[0] ?? "show";
  if (sub === "path") {
    process.stdout.write(`${configStore.path}\n`);
    return;
  }
  if (sub === "get" && rest[1]) {
    const [section, key] = rest[1].split(".");
    const value = (configStore.value as unknown as Record<string, Record<string, unknown>>)[section ?? ""]?.[key ?? ""];
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (sub === "set" && rest[1] && rest[2] !== undefined) {
    try {
      configStore.set(rest[1], rest.slice(2).join(" "));
      process.stdout.write(`${rest[1]} updated\n`);
    } catch (err) {
      fail((err as Error).message);
    }
    return;
  }
  if (sub === "init") {
    configStore.save();
    process.stdout.write(`wrote ${configStore.path}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(configStore.value, null, 2).replace(/"apiKey": "([^"]*)"/, (_m, v: string) => `"apiKey": "${v ? "***" : ""}"`)}\n`);
}

function sessionsCommand(store: SessionStore, rest: string[], flags: Record<string, string | boolean>): void {
  const sub = rest[0] ?? "list";
  if (sub === "list" || sub === "ls") {
    const list = store.list({ limit: Number(flagString(flags, "limit") ?? 50) });
    if (flagBool(flags, "json")) {
      process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
      return;
    }
    for (const s of list) {
      const when = new Date(s.updatedAt).toISOString().slice(0, 16).replace("T", " ");
      process.stdout.write(
        `${s.id.slice(2, 10)}  ${when}  ${String(s.messageCount).padStart(4)} msg  ${fmtTokens(s.tokens).padStart(6)} tok  ${s.title}\n`,
      );
    }
    if (!list.length) process.stdout.write("no sessions yet\n");
    return;
  }
  if (sub === "show") {
    const id = rest[1];
    if (!id) fail("usage: kono sessions show <id>");
    const session = store.load(id) ?? (() => {
      const hit = store.list().find((s) => s.id.startsWith(id));
      return hit ? store.load(hit.id) : null;
    })();
    if (!session) fail(`no session matching "${id}"`);
    process.stdout.write(`${session.toMarkdown()}\n`);
    return;
  }
  if (sub === "rm" || sub === "delete") {
    const id = rest[1];
    if (!id) fail("usage: kono sessions rm <id>");
    const hit = store.list().find((s) => s.id === id || s.id.startsWith(id));
    if (!hit) fail(`no session matching "${id}"`);
    store.delete(hit.id);
    process.stdout.write(`deleted ${hit.id}\n`);
    return;
  }
  if (sub === "export") {
    const id = rest[1];
    if (!id) fail("usage: kono sessions export <id> [path]");
    const hit = store.list().find((s) => s.id === id || s.id.startsWith(id));
    if (!hit) fail(`no session matching "${id}"`);
    const session = store.load(hit.id);
    if (!session) fail("could not load session");
    const target = resolve(rest[2] ?? `${safeFileName(session.meta.title)}.json`);
    writeFileSync(target, store.exportJson(session), "utf8");
    process.stdout.write(`exported → ${target}\n`);
    return;
  }
  if (sub === "import") {
    const path = rest[1];
    if (!path) fail("usage: kono sessions import <file>");
    const session = store.importJson(readFileSync(resolve(path), "utf8"));
    process.stdout.write(`imported ${session.meta.id} (${session.meta.title})\n`);
    return;
  }
  if (sub === "search") {
    const query = rest.slice(1).join(" ");
    if (!query) fail("usage: kono sessions search <query>");
    const hits = store.search(query, { limit: 60 });
    for (const hit of hits) {
      process.stdout.write(`${hit.sessionTitle}  [${hit.role}]  ${hit.snippet}\n`);
    }
    if (!hits.length) process.stdout.write("no matches\n");
    return;
  }
  fail(`unknown sessions subcommand "${sub}"`);
}

function memoryCommand(home: string, store: SessionStore, configStore: ConfigStore, rest: string[], cwd: string): void {
  const sub = rest[0] ?? "list";
  const banks: MemoryBank[] = [new MemoryBank(paths(home).memory, "global", { halfLifeDays: configStore.value.memory.halfLifeDays })];
  if (configStore.value.memory.useProjectMemory) {
    banks.push(new MemoryBank(projectMemoryPath(cwd), "project", { halfLifeDays: configStore.value.memory.halfLifeDays }));
  }
  const stack = new MemoryStack(banks);

  if (sub === "list" || sub === "ls") {
    for (const item of stack.all()) {
      const pin = item.pinned ? "📌" : "  ";
      process.stdout.write(`${pin} ${item.scope.padEnd(7)} ${item.kind.padEnd(10)} ${item.id.slice(4, 10)}  ${item.text}\n`);
    }
    return;
  }
  if (sub === "add") {
    const text = rest.slice(1).join(" ");
    if (!text) fail("usage: kono memory add <text>");
    const { item, action } = banks[banks.length - 1]!.add(text, { kind: "note", source: { kind: "manual" } });
    process.stdout.write(`${action}: ${item.id} (${item.scope})\n`);
    return;
  }
  if (sub === "rm" || sub === "forget") {
    const target = rest[1];
    if (!target) fail("usage: kono memory rm <id|text>");
    let removed = 0;
    for (const bank of banks) {
      const found = bank.find(target) ?? bank.items.find((i) => i.text.toLowerCase().includes(target.toLowerCase()));
      if (found && bank.remove(found.id)) removed++;
    }
    process.stdout.write(removed ? `removed ${removed}\n` : "no match\n");
    return;
  }
  if (sub === "search") {
    const query = rest.slice(1).join(" ");
    for (const item of stack.retrieve(query, { topK: 20, tokenBudget: 4000 })) {
      process.stdout.write(`${item.scope.padEnd(7)} ${item.kind.padEnd(10)} ${item.text}\n`);
    }
    return;
  }
  if (sub === "stats") {
    const stats = stack.stats();
    process.stdout.write(`${stats.total} items · ${stats.pinned} pinned · ~${stats.tokens} tokens\n`);
    for (const bank of stats.banks) process.stdout.write(`  ${bank.scope}: ${bank.items} (${bank.path})\n`);
    return;
  }
  if (sub === "export") {
    const target = resolve(rest[1] ?? `kono-memory-${Date.now()}.json`);
    const exportBank = banks[banks.length - 1]!;
    writeFileSync(target, exportBank.export(), "utf8");
    process.stdout.write(`exported ${exportBank.items.length} items → ${target}\n`);
    return;
  }
  if (sub === "import") {
    const path = rest[1];
    if (!path) fail("usage: kono memory import <file>");
    const added = banks[banks.length - 1]!.importJson(readFileSync(resolve(path), "utf8"));
    process.stdout.write(`imported ${added} items\n`);
    return;
  }
  void store;
  fail(`unknown memory subcommand "${sub}"`);
}

async function modelsCommand(router: RouterClient, json: boolean): Promise<void> {
  try {
    const catalog = await router.models();
    const models = catalogModels(catalog);
    if (json) {
      process.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
      return;
    }
    for (const model of models) {
      const iq = model.iq ?? (model as Record<string, unknown>).quality;
      const ctxLen = model.context_length ?? model.contextLength;
      process.stdout.write(`${model.id.padEnd(52)} ${String(iq ?? "").padStart(4)} ${ctxLen ? fmtTokens(Number(ctxLen)) : ""}\n`);
    }
    process.stdout.write(`\n${models.length} models\n`);
  } catch (err) {
    fail((err as Error).message);
  }
}

async function toolsCommand(router: RouterClient, rest: string[], json: boolean): Promise<void> {
  const sub = rest[0];
  try {
    if (sub === "run") {
      const name = rest[1];
      if (!name) fail("usage: kono tools run <name> [json]");
      let args: unknown = {};
      const raw = rest.slice(2).join(" ");
      if (raw) {
        try {
          args = JSON.parse(raw);
        } catch {
          fail("arguments must be JSON");
        }
      }
      const result = await router.executeTools({ name, arguments: args });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    const catalog = await router.tools({ schemas: !json });
    if (json) {
      process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
      return;
    }
    const tools = catalog.data ?? catalog.tools ?? [];
    for (const tool of tools) {
      const name = String(tool.name ?? "?");
      const desc = String(tool.description ?? "").replace(/\s+/g, " ").slice(0, 70);
      process.stdout.write(`${name.padEnd(28)} ${desc}\n`);
    }
    process.stdout.write(`\n${tools.length} tools\n`);
  } catch (err) {
    fail((err as Error).message);
  }
}

async function doctorCommand(configStore: ConfigStore, router: RouterClient, store: SessionStore): Promise<void> {
  const cfg = configStore.value;
  process.stdout.write(`kono ${VERSION} · node ${process.versions.node} · ${process.platform}\n`);
  process.stdout.write(`home      ${store.home}\n`);
  process.stdout.write(`config    ${configStore.path}\n`);
  process.stdout.write(`router    ${cfg.router.baseUrl}\n`);
  process.stdout.write(`api key   ${router.hasKey ? configStore.maskKey() : "MISSING"}\n`);
  process.stdout.write(`theme     ${cfg.ui.theme} · colour ${detectColorMode()}\n`);
  process.stdout.write(`hosted    ${HOSTED_GATEWAY} · \`kono gateway\` for status\n`);
  const started = Date.now();
  try {
    const health = await router.health();
    process.stdout.write(`health    ok in ${Date.now() - started}ms ${JSON.stringify(health).slice(0, 160)}\n`);
  } catch (err) {
    process.stdout.write(`health    FAILED: ${(err as Error).message}\n`);
  }
  try {
    const models = catalogModels(await router.models());
    process.stdout.write(`catalogue ${models.length} models\n`);
  } catch (err) {
    process.stdout.write(`catalogue FAILED: ${(err as Error).message}\n`);
  }
  const stats = store.stats();
  process.stdout.write(`sessions  ${stats.sessions} · ${(stats.bytes / 1024).toFixed(1)} KiB\n`);
}

/** `kono gateway` — where the hosted gateway lives, and whether it is up. */
async function gatewayCommand(): Promise<void> {
  process.stdout.write(`hosted gateway  ${HOSTED_GATEWAY}\n`);
  const started = Date.now();
  try {
    const res = await fetch(`${HOSTED_GATEWAY}/healthz`, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json()) as { ok?: boolean; keyConfigured?: boolean; upstream?: string };
    process.stdout.write(
      `status          ${res.status} in ${Date.now() - started}ms · ${body.ok ? "ok" : "degraded"} · key ${body.keyConfigured ? "configured" : "not configured"}\n`,
    );
    process.stdout.write(`upstream        ${body.upstream ?? "unknown"}\n`);
  } catch (err) {
    process.stdout.write(`status          unreachable: ${(err as Error).message}\n`);
  }
  process.stdout.write(`route through it  export KONO_BASE_URL=${HOSTED_GATEWAY}\n`);
  process.stdout.write(`verify            npm run check:gateway -- ${HOSTED_GATEWAY}\n`);
}

async function proxyCommand(configStore: ConfigStore, router: RouterClient, flags: Record<string, string | boolean>): Promise<void> {
  const port = Number(flagString(flags, "port") ?? 8787);
  const host = flagString(flags, "host") ?? "127.0.0.1";
  const server = await startProxy({ router, config: configStore, port, host });
  process.stdout.write(`kono proxy listening on http://${host}:${server.port}\n`);
  process.stdout.write(`  → ${configStore.value.router.baseUrl}\n`);
  process.stdout.write("  CORS-enabled passthrough for /v1/* and /health · ctrl+c to stop\n");
  await new Promise<void>((resolvePromise) => {
    const stop = () => {
      server.close();
      resolvePromise();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

function exportCommand(store: SessionStore, rest: string[]): void {
  const id = rest[0];
  if (!id) fail("usage: kono export <session-id> [path]");
  const hit = store.list().find((s) => s.id === id || s.id.startsWith(id));
  if (!hit) fail(`no session matching "${id}"`);
  const session = store.load(hit.id);
  if (!session) fail("could not load session");
  const target = resolve(rest[1] ?? `${safeFileName(session.meta.title)}.md`);
  writeFileSync(target, session.toMarkdown(), "utf8");
  process.stdout.write(`exported → ${target}\n`);
}

function initCommand(): void {
  const path = resolve("KONO.md");
  if (existsSync(path)) fail("KONO.md already exists");
  writeFileSync(
    path,
    `# Project instructions for kono-cli

Injected into every session started in this directory.

## Stack
- 

## Conventions
- 

## Commands
- install:
- test:
- lint:
`,
    "utf8",
  );
  process.stdout.write(`wrote ${path}\n`);
}

void renderMarkdown;
void lineToAnsi;

main().catch((err) => {
  process.stderr.write(`kono: ${(err as Error).message}\n`);
  if (process.env.KONO_DEBUG) process.stderr.write(`${(err as Error).stack}\n`);
  process.exit(1);
});
