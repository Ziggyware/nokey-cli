/**
 * Slash commands.
 *
 * Everything the CLI can do is reachable from the composer: `/retry` on a weak
 * answer, `/branch` to fork a thread, `/memory rm` to correct a wrong fact,
 * `/compact` to reclaim context. The same table powers the command palette, the
 * help sheet and Tab completion, so nothing can drift out of sync.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { THEMES, THEME_NAMES } from "../ui/theme.ts";
import { extractCodeBlocks } from "../render/markdown.ts";
import { fmtRelative, fmtDuration } from "../util/time.ts";
import { fmtTokens, estimateTokens } from "../util/tokens.ts";
import { prettyJson } from "../ui/transcript.ts";
import { OVERLAY_TITLES } from "../ui/overlays.ts";
import type { SlashCommand } from "./types.ts";

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [k, v] = arg.slice(2).split("=");
      flags[k!] = v ?? true;
    } else if (arg.startsWith("-") && arg.length === 2) {
      flags[arg.slice(1)] = true;
    } else positional.push(arg);
  }
  return { positional, flags };
}

function messageAt(host: CommandHostLike, index: number) {
  const path = host.session.path();
  return path[index - 1];
}

type CommandHostLike = import("./types.ts").CommandHost;

export const COMMANDS: SlashCommand[] = [
  {
    name: "help",
    aliases: ["?", "keys"],
    summary: "Show shortcuts and every command",
    category: "app",
    keys: "?",
    run: (host) => host.showHelp(),
  },
  {
    name: "new",
    aliases: ["n"],
    summary: "Start a fresh session",
    usage: "/new [title]",
    category: "session",
    keys: "Ctrl+N",
    run: (host, args) => {
      host.newSession(args.length ? { title: args.join(" ") } : {});
      host.notice("started a new session", "ok");
    },
  },
  {
    name: "sessions",
    aliases: ["ls"],
    summary: "Browse and switch sessions",
    category: "session",
    keys: "Ctrl+S",
    run: (host) => {
      const list = host.sessions();
      host.openOverlay({
        kind: "list",
        title: OVERLAY_TITLES.sessions!,
        subtitle: `${list.length} saved`,
        query: "",
        items: list.map((s) => ({
          id: s.id,
          label: s.title,
          badge: s.starred ? "★" : undefined,
          hint: `${s.messageCount} msgs · ${fmtTokens(s.tokens)} tok · ${fmtRelative(s.updatedAt)}`,
          meta: s.id.slice(2, 8),
          detail: s.preview,
          tone: s.id === host.session.id ? "ok" : "fg",
        })),
        cursor: Math.max(0, list.findIndex((s) => s.id === host.session.id)),
        footer: "⏎ open · d delete · r rename · ★ star · esc close",
      });
    },
  },
  {
    name: "resume",
    aliases: ["open"],
    summary: "Switch to a session by id or list index",
    usage: "/resume <id|index>",
    category: "session",
    run: (host, args) => {
      const target = args[0];
      if (!target) {
        const list = host.sessions();
        const items = list.map((s) => ({ id: s.id, label: s.title, hint: `${s.messageCount} msgs · ${fmtRelative(s.updatedAt)}` }));
        host.openOverlay({ kind: "list", title: "Resume session", query: "", items, cursor: 0 });
        return;
      }
      const list = host.sessions();
      const byIndex = Number.parseInt(target, 10);
      const id = Number.isFinite(byIndex) ? list[byIndex - 1]?.id : list.find((s) => s.id === target || s.id.startsWith(target))?.id;
      if (!id) {
        host.notice(`no session matching "${target}"`, "error");
        return;
      }
      host.switchSession(id);
    },
  },
  {
    name: "rename",
    aliases: ["title"],
    summary: "Rename the current session",
    usage: "/rename <title>",
    category: "session",
    run: (host, args) => {
      if (!args.length) {
        host.print(`Current title: **${host.session.meta.title}**`);
        return;
      }
      host.session.rename(args.join(" "));
      host.notice(`renamed to "${host.session.meta.title}"`, "ok");
      host.refresh();
    },
  },
  {
    name: "model",
    aliases: ["m"],
    summary: "Choose the model or lane (free:auto, free:smart, free:code, …)",
    usage: "/model [lane|model]",
    category: "model",
    keys: "Ctrl+O",
    run: async (host, args) => {
      if (!args.length) {
        const models = await host.listModels();
        const lanes = ["free:auto", "free:fast", "free:smart", "free:code", "free:reasoning"];
        const items = [
          ...lanes.map((l) => ({ id: l, label: l, badge: "lane", hint: l === host.session.meta.model ? "current" : "", tone: "accent2" as const })),
          ...models.map((m) => ({ id: m, label: m, hint: m === host.session.meta.model ? "current" : "", tone: "fg" as const })),
        ];
        host.openOverlay({ kind: "list", title: OVERLAY_TITLES.models!, query: "", items, cursor: 0 });
        return;
      }
      const model = args[0]!;
      host.session.patchMeta({ model });
      host.configStore.value.model.default = model;
      host.saveConfig();
      host.notice(`model → ${model}`, "ok");
      host.refresh();
    },
  },
  {
    name: "models",
    summary: "List routable models from /v1/models",
    category: "model",
    run: async (host) => {
      const models = await host.listModels();
      if (!models.length) {
        host.print("_No catalogue returned — check `/doctor`._");
        return;
      }
      host.print(`### ${models.length} models\n\n${models.map((m) => `- \`${m}\``).join("\n")}`);
    },
  },
  {
    name: "theme",
    summary: "Switch colour theme",
    usage: "/theme [midnight|aurora|accessible|daylight|mono]",
    category: "app",
    keys: "Ctrl+T",
    run: (host, args) => {
      if (!args.length) {
        host.openOverlay({
          kind: "list",
          title: OVERLAY_TITLES.themes!,
          query: "",
          items: THEME_NAMES.map((name) => ({
            id: name,
            label: name,
            hint: THEMES[name]!.label,
            badge: host.theme.name === name ? "●" : " ",
            tone: "fg",
          })),
          cursor: Math.max(0, THEME_NAMES.indexOf(host.theme.name)),
          footer: "⏎ apply · esc close",
        });
        return;
      }
      const name = args[0]!;
      if (!host.setTheme(name)) {
        host.notice(`unknown theme "${name}" — try ${THEME_NAMES.join(", ")}`, "error");
        return;
      }
      host.configStore.value.ui.theme = name;
      host.saveConfig();
      host.notice(`theme → ${name}`, "ok");
    },
  },
  {
    name: "system",
    aliases: ["persona"],
    summary: "Set the session system prompt",
    usage: "/system <text>  ·  /system clear",
    category: "session",
    run: (host, args) => {
      if (!args.length) {
        const current = host.session.meta.systemPrompt;
        host.print(current ? `### System prompt\n\n\`\`\`text\n${current}\n\`\`\`` : "_No custom system prompt (using the default persona)._");
        return;
      }
      if (args[0] === "clear" || args[0] === "reset") {
        host.session.patchMeta({ systemPrompt: "" });
        host.notice("system prompt cleared", "ok");
        return;
      }
      const text = args.join(" ");
      host.session.patchMeta({ systemPrompt: text });
      host.notice("system prompt updated", "ok");
      host.refresh();
    },
  },
  {
    name: "memory",
    summary: "Browse, add, pin or forget memories",
    usage: "/memory [list|add|rm|pin|search|promote|export]",
    category: "memory",
    keys: "Ctrl+M",
    run: (host, args) => {
      const { positional } = parseFlags(args);
      const sub = positional[0] ?? "list";
      if (sub === "list") {
        const items = host.memory.all();
        host.openOverlay({
          kind: "list",
          title: OVERLAY_TITLES.memory!,
          subtitle: `${items.length} items · ${host.memory.stats().pinned} pinned`,
          query: "",
          items: items.map((m) => ({
            id: m.id,
            label: m.text,
            badge: m.pinned ? "📌" : m.kind.slice(0, 3),
            hint: `${m.scope} · ${m.hits} hits · ${fmtRelative(m.updatedAt)}`,
            detail: `${m.kind} ${m.tags?.join(" ") ?? ""}`,
            tone: m.scope === "session" ? "accent3" : m.scope === "project" ? "accent2" : "memory",
          })),
          cursor: 0,
          footer: "⏎ pin/unpin · d forget · esc close",
        });
        return;
      }
      if (sub === "add" || sub === "remember") {
        const text = positional.slice(1).join(" ");
        if (!text) {
          host.notice("usage: /memory add <text>", "warn");
          return;
        }
        const { item } = host.autoBank.add(text, { kind: "note", source: { kind: "manual" } });
        host.notice(`remembered (${item.kind})`, "ok");
        host.refresh();
        return;
      }
      if (sub === "rm" || sub === "forget") {
        const target = positional[1];
        if (!target) {
          host.notice("usage: /memory rm <id|text>", "warn");
          return;
        }
        for (const bank of host.memory.banks) {
          const byId = bank.find(target);
          if (byId) {
            bank.remove(byId.id);
            host.notice("memory removed", "ok");
            host.refresh();
            return;
          }
        }
        const matches = host.memory.all().filter((m) => m.text.toLowerCase().includes(target.toLowerCase()));
        if (!matches.length) {
          host.notice("no matching memory", "error");
          return;
        }
        for (const bank of host.memory.banks) {
          for (const m of matches.filter((x) => x.scope === bank.scope)) bank.remove(m.id);
        }
        host.notice(`removed ${matches.length} memory item${matches.length === 1 ? "" : "s"}`, "ok");
        host.refresh();
        return;
      }
      if (sub === "pin" || sub === "unpin") {
        const target = positional[1];
        const pin = sub === "pin";
        const found = host.memory.all().filter((m) => target && (m.id.startsWith(target) || m.text.toLowerCase().includes(target.toLowerCase())));
        if (!found.length) {
          host.notice("no matching memory", "error");
          return;
        }
        for (const bank of host.memory.banks) {
          for (const m of found.filter((x) => x.scope === bank.scope)) bank.update(m.id, { pinned: pin });
        }
        host.notice(`${pin ? "pinned" : "unpinned"} ${found.length}`, "ok");
        host.refresh();
        return;
      }
      if (sub === "search") {
        const q = positional.slice(1).join(" ");
        const results = host.memory.all().filter((m) => m.text.toLowerCase().includes(q.toLowerCase()));
        host.print(results.length ? `### ${results.length} matches\n\n${results.map((m) => `- \`${m.id.slice(4, 10)}\` ${m.text}`).join("\n")}` : "_No matches._");
        return;
      }
      if (sub === "promote") {
        const target = positional[1];
        const found = host.memory.all().find((m) => target && m.id.startsWith(target));
        if (!found) {
          host.notice("usage: /memory promote <id>", "warn");
          return;
        }
        const { item } = host.autoBank.add(found.text, { kind: found.kind, pinned: true, source: { kind: "manual" } });
        host.notice(`promoted to ${item.scope}`, "ok");
        host.refresh();
        return;
      }
      if (sub === "export") {
        const path = resolve(positional[1] ?? `kono-memory-${Date.now()}.json`);
        writeFileSync(path, host.autoBank.export(), "utf8");
        host.print(`Exported ${host.autoBank.items.length} memories → \`${path}\``);
        return;
      }
      host.notice(`unknown subcommand "${sub}"`, "error");
    },
  },
  {
    name: "remember",
    aliases: ["mem"],
    summary: "Store a durable fact",
    usage: "/remember <text>  [--pin] [--kind=preference]",
    category: "memory",
    run: (host, args) => {
      const { positional, flags } = parseFlags(args);
      const text = positional.join(" ");
      if (!text) {
        host.notice("usage: /remember <text>", "warn");
        return;
      }
      const kind = typeof flags.kind === "string" ? (flags.kind as never) : "note";
      const { item, action } = host.autoBank.add(text, { kind, pinned: Boolean(flags.pin), source: { kind: "manual" } });
      host.notice(`${action === "duplicate" ? "already known" : "remembered"}: ${item.text.slice(0, 60)}`, "ok");
      host.refresh();
    },
  },
  {
    name: "forget",
    summary: "Remove a memory by id or text",
    usage: "/forget <id|text>",
    category: "memory",
    run: (host, args) => {
      const target = args.join(" ");
      if (!target) {
        host.notice("usage: /forget <id|text>", "warn");
        return;
      }
      let removed = 0;
      for (const bank of host.memory.banks) {
        const found = bank.find(target) ?? bank.items.find((i) => i.text.toLowerCase().includes(target.toLowerCase()));
        if (found && bank.remove(found.id)) removed++;
      }
      if (!removed) host.notice("no matching memory", "error");
      else {
        host.notice(`forgot ${removed} item${removed === 1 ? "" : "s"}`, "ok");
        host.refresh();
      }
    },
  },
  {
    name: "compact",
    aliases: ["summarize"],
    summary: "Fold older turns into a summary to reclaim context",
    category: "context",
    run: async (host) => {
      host.notice("compacting…", "info");
      const result = await host.engine.compactNow();
      if (!result) {
        host.notice("nothing to compact yet", "warn");
        return;
      }
      host.notice(`compacted ${result.count} messages (${result.via})`, "ok");
      host.refresh();
    },
  },
  {
    name: "tokens",
    summary: "Show the context budget breakdown",
    category: "context",
    run: (host) => {
      const path = host.session.path();
      let user = 0;
      let assistant = 0;
      let reasoning = 0;
      let tools = 0;
      for (const m of path) {
        const tokens = estimateTokens(m.content);
        if (m.role === "user") user += tokens;
        else if (m.role === "assistant") assistant += tokens;
        else if (m.role === "tool") tools += tokens;
        reasoning += estimateTokens(m.reasoning ?? "");
      }
      const total = user + assistant + tools;
      const window = host.configStore.value.context.windowTokens;
      host.print(
        [
          "### Context budget",
          "",
          `| bucket | tokens | share |`,
          `|:--|--:|--:|`,
          `| user | ${fmtTokens(user)} | ${pct(user, total)} |`,
          `| assistant | ${fmtTokens(assistant)} | ${pct(assistant, total)} |`,
          `| tool results | ${fmtTokens(tools)} | ${pct(tools, total)} |`,
          `| reasoning (not sent) | ${fmtTokens(reasoning)} | — |`,
          `| **total sent** | **${fmtTokens(total)}** | of ${fmtTokens(window)} |`,
          "",
          `Compaction: **${host.configStore.value.context.compaction}** at ${Math.round(host.configStore.value.context.compactAt * 100)}% · keep last ${host.configStore.value.context.keepRecent} messages`,
        ].join("\n"),
      );
    },
  },
  {
    name: "clear",
    summary: "Clear the on-screen log (keeps the conversation)",
    category: "app",
    run: (host) => {
      host.print("");
      host.refresh();
    },
  },
  {
    name: "export",
    aliases: ["save"],
    summary: "Export the conversation as markdown or JSON",
    usage: "/export [md|json] [path]",
    category: "workspace",
    run: async (host, args) => {
      const format = args[0] === "json" ? "json" : "md";
      const path = await host.exportSession(format, args[1]);
      host.print(`Exported → \`${path}\``);
    },
  },
  {
    name: "import",
    summary: "Import a previously exported session",
    usage: "/import <path>",
    category: "workspace",
    run: async (host, args) => {
      if (!args[0]) {
        host.notice("usage: /import <path>", "warn");
        return;
      }
      await host.importSession(args[0]);
    },
  },
  {
    name: "copy",
    summary: "Copy the last code block (or message N) to the clipboard",
    usage: "/copy [message#]",
    category: "app",
    keys: "Ctrl+Y",
    run: async (host, args) => {
      const index = args[0] ? Number.parseInt(args[0], 10) : host.session.path().length;
      const msg = Number.isFinite(index) ? messageAt(host, index) : undefined;
      if (!msg) {
        host.notice("no such message", "error");
        return;
      }
      const blocks = extractCodeBlocks(msg.content);
      const text = blocks.length ? blocks[blocks.length - 1]!.code : msg.content;
      const method = await host.copyToClipboard(text);
      host.notice(`copied ${text.length} chars via ${method}`, "ok");
    },
  },
  {
    name: "retry",
    aliases: ["regen"],
    summary: "Regenerate the last answer as a new branch",
    category: "model",
    keys: "Ctrl+G",
    run: (host) => host.retry(),
  },
  {
    name: "edit",
    summary: "Edit message N and re-run from there",
    usage: "/edit <n> <new text>",
    category: "session",
    run: (host, args) => {
      const index = Number.parseInt(args[0] ?? "", 10);
      const text = args.slice(1).join(" ");
      const msg = Number.isFinite(index) ? messageAt(host, index) : undefined;
      if (!msg) {
        host.notice("usage: /edit <n> <new text>", "warn");
        return;
      }
      if (!text) {
        host.notice("nothing to replace with", "warn");
        return;
      }
      if (msg.role !== "user") {
        host.notice("only user messages can be edited", "error");
        return;
      }
      host.session.update(msg.id, { content: text, editedAt: Date.now() });
      host.session.setLeaf(msg.id);
      host.notice(`edited #${index} — regenerating`, "ok");
      host.send(text);
    },
  },
  {
    name: "branch",
    summary: "Fork from message N (keeps both futures)",
    usage: "/branch [n]",
    category: "session",
    run: (host, args) => {
      const path = host.session.path();
      const index = args[0] ? Number.parseInt(args[0], 10) : path.length;
      const msg = path[index - 1];
      if (!msg) {
        host.notice("no such message", "error");
        return;
      }
      host.session.setLeaf(msg.id);
      host.notice(`branched at #${index} — next message starts a new thread`, "ok");
      host.refresh();
    },
  },
  {
    name: "tree",
    summary: "Show the conversation tree",
    category: "session",
    run: (host) => {
      const session = host.session;
      const lines: string[] = ["### Message tree", ""];
      const walk = (parent: string | null, depth: number) => {
        for (const child of session.children(parent)) {
          const active = session.path().some((m) => m.id === child.id);
          const marker = active ? "●" : "○";
          const siblings = session.siblings(child.id).length;
          const label = child.content.replace(/\s+/g, " ").slice(0, 54) || "(empty)";
          lines.push(`${"  ".repeat(depth)}${marker} ${child.role === "user" ? "you" : child.role} · ${label}${siblings > 1 ? `  ⑂1/${siblings}` : ""}`);
          walk(child.id, depth + 1);
        }
      };
      walk(null, 0);
      lines.push("", `Active path: ${session.path().length} messages · leaf \`${(session.leafId ?? "none").slice(0, 10)}\``);
      host.print(lines.join("\n"));
    },
  },
  {
    name: "delete",
    summary: "Hide message N and everything after it",
    usage: "/delete <n>",
    category: "session",
    run: (host, args) => {
      const index = Number.parseInt(args[0] ?? "", 10);
      const path = host.session.path();
      const msg = path[index - 1];
      if (!msg) {
        host.notice("usage: /delete <n>", "warn");
        return;
      }
      const toHide = path.slice(index - 1);
      host.confirm("Delete messages", `Hide message #${index} and ${toHide.length - 1} after it? History is kept in the log.`, () => {
        for (const m of toHide) host.session.hide(m.id);
        host.session.setLeaf(msg.parentId);
        host.notice(`hid ${toHide.length} messages`, "ok");
        host.refresh();
      });
    },
  },
  {
    name: "pin",
    aliases: ["unpin"],
    summary: "Pin message N so compaction never folds it away",
    usage: "/pin <n>",
    category: "context",
    run: (host, args, raw) => {
      const pin = !raw.trim().startsWith("/unpin");
      const index = Number.parseInt(args[0] ?? "", 10);
      const msg = Number.isFinite(index) ? messageAt(host, index) : undefined;
      if (!msg) {
        host.notice("usage: /pin <n>", "warn");
        return;
      }
      host.session.update(msg.id, { pinned: pin });
      host.notice(`${pin ? "pinned" : "unpinned"} #${index}`, "ok");
      host.refresh();
    },
  },
  {
    name: "find",
    aliases: ["search"],
    summary: "Search this session (or all sessions with --all)",
    usage: "/find <query> [--all]",
    category: "workspace",
    keys: "Ctrl+F",
    run: (host, args) => {
      const { positional, flags } = parseFlags(args);
      const query = positional.join(" ");
      if (!query) {
        host.notice("usage: /find <query>", "warn");
        return;
      }
      const hits = host.store.search(query, flags.all ? { sessionId: undefined, limit: 80 } : { sessionId: host.session.id, limit: 80 });
      if (!hits.length) {
        host.print(`_No matches for “${query}”._`);
        return;
      }
      const rows = hits
        .slice(0, 40)
        .map((h) => `- **${h.role}** ${flags.all ? `· \`${h.sessionTitle}\`` : ""} — ${h.snippet.replace(/\n/g, " ")}`);
      host.print(`### ${hits.length} matches for “${query}”\n\n${rows.join("\n")}`);
    },
  },
  {
    name: "stats",
    summary: "Session, memory and storage statistics",
    category: "app",
    run: (host) => {
      const session = host.session;
      const path = session.path();
      const timeByModel = new Map<string, number>();
      let totalMs = 0;
      let tokensOut = 0;
      for (const m of path) {
        if (m.telemetry?.totalMs) {
          totalMs += m.telemetry.totalMs;
          const key = m.telemetry.model ?? m.model ?? "unknown";
          timeByModel.set(key, (timeByModel.get(key) ?? 0) + m.telemetry.totalMs);
        }
        tokensOut += m.telemetry?.completionTokens ?? 0;
      }
      const stats = host.store.stats();
      const mem = host.memory.stats();
      host.print(
        [
          "### Session",
          `- messages: **${path.length}** · branches: **${session.leaves().length}**`,
          `- model: \`${session.meta.model}\` · created ${fmtRelative(session.meta.createdAt)}`,
          `- generation time: **${fmtDuration(totalMs)}** · completion tokens: **${fmtTokens(tokensOut)}**`,
          ...(timeByModel.size ? ["", "### Lanes", ...Array.from(timeByModel.entries()).map(([m, ms]) => `- \`${m}\` — ${fmtDuration(ms)}`)] : []),
          "",
          "### Memory",
          `- **${mem.total}** items · ${mem.pinned} pinned · ~${fmtTokens(mem.tokens)} tokens`,
          ...mem.banks.map((b) => `- ${b.scope}: ${b.items} (\`${b.path}\`)`),
          "",
          "### Storage",
          `- ${stats.sessions} sessions · ${(stats.bytes / 1024).toFixed(1)} KiB in \`${host.store.home}\``,
        ].join("\n"),
      );
    },
  },
  {
    name: "doctor",
    summary: "Check connectivity, auth, clock and configuration",
    category: "app",
    run: async (host) => {
      const lines: string[] = ["### Diagnostics", ""];
      const cfg = host.configStore.value;
      lines.push(`- router: \`${cfg.router.baseUrl}\``);
      lines.push(`- api key: ${host.router.hasKey ? `configured (${host.configStore.maskKey()})` : "**missing**"}`);
      lines.push(`- theme: \`${host.theme.name}\` · node ${process.versions.node} · ${process.platform}`);
      const started = Date.now();
      try {
        const health = await host.router.health();
        const ms = Date.now() - started;
        lines.push(`- health: **ok** in ${ms}ms — ${health.coverage ? `coverage ${JSON.stringify(health.coverage).slice(0, 90)}` : "reachable"}`);
      } catch (err) {
        lines.push(`- health: **failed** — ${(err as Error).message}`);
      }
      try {
        const models = await host.listModels();
        lines.push(`- catalogue: **${models.length}** models`);
      } catch (err) {
        lines.push(`- catalogue: **failed** — ${(err as Error).message}`);
      }
      try {
        const tools = await host.router.tools({ schemas: false });
        const count = tools.data?.length ?? tools.tools?.length ?? 0;
        lines.push(`- tool plane: **${count}** tools`);
      } catch {
        lines.push("- tool plane: unavailable");
      }
      lines.push(`- storage: \`${host.store.home}\``);
      host.print(lines.join("\n"));
    },
  },
  {
    name: "key",
    summary: "Set the router API key (stored 0600 in your config)",
    usage: "/key <ROUTER_API_KEY>",
    category: "app",
    run: (host, args) => {
      const key = args[0];
      if (!key) {
        host.print(`API key: ${host.router.hasKey ? `\`${host.configStore.maskKey()}\`` : "**not set**"}\n\nSet it with \`/key <value>\` or \`export KONO_API_KEY=…\`.`);
        return;
      }
      host.configStore.value.router.apiKey = key;
      host.saveConfig();
      host.router.setApiKey(key);
      host.notice(`key saved (${host.configStore.maskKey()})`, "ok");
    },
  },
  {
    name: "base",
    summary: "Point the CLI at a different router URL",
    usage: "/base <url>",
    category: "app",
    run: (host, args) => {
      const url = args[0];
      if (!url) {
        host.print(`Router: \`${host.configStore.value.router.baseUrl}\``);
        return;
      }
      const next = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      host.configStore.value.router.baseUrl = next.replace(/\/+$/, "");
      host.saveConfig();
      host.reloadConfig();
      host.notice(`router → ${next}`, "ok");
    },
  },
  {
    name: "config",
    summary: "Show or change settings",
    usage: "/config [get <path>|set <path> <value>|path]",
    category: "app",
    run: (host, args) => {
      const sub = args[0];
      if (sub === "path") {
        host.print(`\`${host.configStore.path}\``);
        return;
      }
      if (sub === "get" && args[1]) {
        const [section, key] = args[1].split(".");
        const value = (host.configStore.value as unknown as Record<string, Record<string, unknown>>)[section ?? ""]?.[key ?? ""];
        host.print(`\`${args[1]}\` = \`${JSON.stringify(value)}\``);
        return;
      }
      if (sub === "set" && args[1] && args[2] !== undefined) {
        try {
          host.configStore.set(args[1], args.slice(2).join(" "));
          host.reloadConfig();
          host.notice(`${args[1]} updated`, "ok");
        } catch (err) {
          host.notice((err as Error).message, "error");
        }
        return;
      }
      host.print(host.settingsSummary());
    },
  },
  {
    name: "tools",
    summary: "List the router's executable tools",
    category: "tools",
    run: async (host) => {
      try {
        const catalog = await host.router.tools({ schemas: false });
        const tools = catalog.data ?? catalog.tools ?? [];
        if (!tools.length) {
          host.print("_No tools returned._");
          return;
        }
        const rows = tools.slice(0, 60).map((tool) => {
          const name = String(tool.name ?? tool.id ?? "?");
          const desc = String(tool.description ?? "").replace(/\s+/g, " ").slice(0, 80);
          const calls = tool.calls ?? (tool.skill as Record<string, unknown> | undefined)?.calls ?? "";
          return `| \`${name}\` | ${desc} | ${calls === "" ? "—" : String(calls)} |`;
        });
        host.print(`### Tool plane — ${tools.length} tools\n\n| tool | description | calls |\n|:--|:--|--:|\n${rows.join("\n")}\n\nRun one with \`/tool <name> [json]\`.`);
      } catch (err) {
        host.notice(`tools failed: ${(err as Error).message}`, "error");
      }
    },
  },
  {
    name: "tool",
    summary: "Execute a tool on the router's tool plane",
    usage: "/tool <name> [jsonArgs]",
    category: "tools",
    run: async (host, args) => {
      const name = args[0];
      if (!name) {
        host.notice("usage: /tool <name> [jsonArgs]", "warn");
        return;
      }
      let parsed: unknown = {};
      const rest = args.slice(1).join(" ");
      if (rest.trim()) {
        try {
          parsed = JSON.parse(rest);
        } catch {
          host.notice("arguments must be JSON", "error");
          return;
        }
      }
      host.notice(`running ${name}…`);
      try {
        const result = await host.router.executeTools({ name, arguments: parsed });
        host.print(`### ${name}\n\n\`\`\`json\n${prettyJson(JSON.stringify(result, null, 2))}\n\`\`\``);
        host.notice(`${name} finished`, "ok");
      } catch (err) {
        host.notice(`${name} failed: ${(err as Error).message}`, "error");
      }
    },
  },
  {
    name: "feedback",
    aliases: ["rate"],
    summary: "Rate the last answer (joins the router's learning loop)",
    usage: "/feedback <up|down> [message#]",
    category: "model",
    run: async (host, args) => {
      const verdict = args[0] === "down" ? "down" : "up";
      const path = host.session.path();
      const index = args[1] ? Number.parseInt(args[1], 10) : path.length;
      const msg = path[index - 1];
      if (!msg || msg.role !== "assistant") {
        host.notice("no assistant message to rate", "error");
        return;
      }
      host.session.update(msg.id, { feedback: verdict });
      host.refresh();
      if (!host.configStore.value.privacy.sendFeedback) {
        host.notice(`rated ${verdict} locally (feedback sending is off)`, "ok");
        return;
      }
      try {
        await host.router.feedback({
          traceId: msg.telemetry?.traceId,
          decision: "thumbs",
          reward: verdict === "up" ? 1 : -1,
        });
        host.notice(`rated ${verdict} — sent to the router`, "ok");
      } catch {
        host.notice(`rated ${verdict} locally (router unreachable)`, "warn");
      }
    },
  },
  {
    name: "undo",
    summary: "Remove the last exchange",
    category: "session",
    run: (host) => {
      const path = host.session.path();
      const lastUser = [...path].reverse().find((m) => m.role === "user");
      if (!lastUser) {
        host.notice("nothing to undo", "warn");
        return;
      }
      for (const m of path.slice(path.indexOf(lastUser))) host.session.hide(m.id);
      host.session.setLeaf(lastUser.parentId);
      host.notice("last exchange removed", "ok");
      host.refresh();
    },
  },
  {
    name: "reasoning",
    aliases: ["think"],
    summary: "Control reasoning display",
    usage: "/reasoning [collapsed|expanded|hidden]",
    category: "app",
    run: (host, args) => {
      const mode = args[0];
      if (!mode) {
        host.print(`Reasoning display: **${host.configStore.value.ui.showReasoning}** · Tab toggles the focused message.`);
        return;
      }
      if (!["collapsed", "expanded", "hidden"].includes(mode)) {
        host.notice("expected collapsed|expanded|hidden", "error");
        return;
      }
      host.configStore.value.ui.showReasoning = mode as never;
      host.saveConfig();
      host.notice(`reasoning → ${mode}`, "ok");
      host.refresh();
    },
  },
  {
    name: "verbose",
    summary: "Toggle the telemetry footer on every message",
    category: "app",
    run: (host) => {
      const next = !host.configStore.value.ui.showTelemetry;
      host.configStore.value.ui.showTelemetry = next;
      host.saveConfig();
      host.notice(`telemetry footer ${next ? "on" : "off"}`, "ok");
      host.refresh();
    },
  },
  {
    name: "init",
    summary: "Write a KONO.md project-instructions file",
    category: "workspace",
    run: (host) => {
      const path = resolve("KONO.md");
      if (existsSync(path)) {
        host.notice("KONO.md already exists", "warn");
        return;
      }
      const content = `# Project instructions for kono-cli

These notes are injected into every session started in this directory.

## Stack
- (language, framework, package manager)

## Conventions
- (formatting, naming, tests)

## Commands
- install:
- test:
- lint:

## Don't
- (things to avoid)
`;
      writeFileSync(path, content, "utf8");
      host.print(`Wrote \`${path}\` — edit it and the next turn will pick it up automatically.`);
    },
  },
  {
    name: "quit",
    aliases: ["exit", "q"],
    summary: "Leave kono",
    category: "app",
    keys: "Ctrl+C ×2",
    run: (host) => host.exit(0),
  },
];

function pct(value: number, total: number): string {
  if (!total) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

export function findCommand(name: string): SlashCommand | undefined {
  const needle = name.toLowerCase();
  return COMMANDS.find((c) => c.name === needle || c.aliases?.includes(needle));
}

export function commandSuggestions(prefix: string): SlashCommand[] {
  const p = prefix.toLowerCase();
  if (!p) return COMMANDS;
  return COMMANDS.filter((c) => c.name.startsWith(p) || c.aliases?.some((a) => a.startsWith(p)));
}

/** Parse "/cmd arg1 arg2" without a shell-reliant tokenizer. */
export function parseCommand(input: string): { name: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const match = /^([a-zA-Z?][\w-]*)(?:\s+([\s\S]*))?$/.exec(body);
  if (!match) return { name: body.split(/\s+/)[0] ?? "", args: body.split(/\s+/).slice(1) };
  const rest = match[2] ?? "";
  return { name: match[1]!, args: rest.trim() ? rest.split(/\s+/) : [] };
}

export { parseFlags };
