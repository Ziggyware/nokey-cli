/**
 * The interactive application.
 *
 * Owns the frame loop, the composer, overlay routing and session switching.
 * Rendering is demand-driven (`#dirty` + a 60 fps ticker), the transcript is
 * cached per message, and every network call is cancellable.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Screen } from "./screen.ts";
import { Composer } from "./editor.ts";
import { parseKeys } from "./keys.ts";
import type { KeyEvent } from "./keys.ts";
import { TranscriptRenderer } from "./transcript.ts";
import type { LiveTurn } from "./transcript.ts";
import { renderFooter, renderHeader, renderInput } from "./status.ts";
import { filteredItems, moveOverlayCursor, renderOverlay } from "./overlays.ts";
import type { OverlayItem, OverlayState } from "./overlays.ts";
import { OVERLAY_TITLES } from "./overlays.ts";
import { getTheme, THEMES } from "./theme.ts";
import type { Theme, Token } from "./theme.ts";
import { lineToAnsi, detectColorMode } from "../util/ansi.ts";
import type { ColorMode } from "../util/ansi.ts";
import { blankCells, cellsWidth, sliceCells, toCells } from "../util/cells.ts";
import type { Cell } from "../util/cells.ts";
import { st } from "./theme.ts";
import { copyToClipboard } from "../util/clipboard.ts";
import { COMMANDS, commandSuggestions, findCommand, parseCommand } from "../commands/slash.ts";
import type { CommandHost, NoticeTone } from "../commands/types.ts";
import type { ConfigStore } from "../store/config.ts";
import type { RouterClient } from "../router/client.ts";
import { catalogModels } from "../router/client.ts";
import type { MemoryBank, MemoryStack } from "../store/memory.ts";
import type { Session, SessionStore, SessionSummary } from "../store/session.ts";
import { safeFileName } from "../util/fsx.ts";
import type { TurnEngine } from "../core/engine.ts";
import { explainError } from "../core/engine.ts";
import type { ContextStats } from "../core/context.ts";
import { renderMarkdown } from "../render/markdown-render.ts";
import { spin } from "../util/time.ts";
import { markdownForHelp } from "./help.ts";

export interface AppDeps {
  configStore: ConfigStore;
  router: RouterClient;
  store: SessionStore;
  session: Session;
  engine: TurnEngine;
  memory: MemoryStack;
  autoBank: MemoryBank;
  sessionBank: MemoryBank;
  makeEngine: (session: Session) => TurnEngine;
  demo?: boolean;
}

interface Notice {
  text: string;
  tone: NoticeTone;
  until: number;
}

export class App implements CommandHost {
  readonly configStore: ConfigStore;
  readonly router: RouterClient;
  readonly store: SessionStore;
  readonly memory: MemoryStack;
  readonly autoBank: MemoryBank;
  readonly sessionBank: MemoryBank;
  session: Session;
  engine: TurnEngine;
  theme: Theme;
  pendingConfirm: (() => void) | null = null;

  #deps: AppDeps;
  #screen: Screen;
  #composer = new Composer();
  #renderer: TranscriptRenderer;
  #colorMode: ColorMode;
  #themeName: string;

  #log: Cell[][] = [];
  #overlay: OverlayState | null = null;
  #overlayAccept: ((item: OverlayItem) => void) | null = null;
  #overlayKey: ((key: KeyEvent) => boolean) | null = null;
  #overlaySearch = "";

  #live: LiveTurn | null = null;
  #busy = false;
  #spinnerFrame = 0;
  #status = "ready";
  #notices: Notice[] = [];
  #lastStats: ContextStats | null = null;
  #degraded = false;
  #online: boolean | null = null;

  #scroll = 0;
  #follow = true;
  #expandedReasoning = new Set<string>();
  #highlight = "";
  #pendingKeys = "";
  #dirty = true;
  #ticker: NodeJS.Timeout | null = null;
  #exitCode: number | null = null;
  #lastInterrupt = 0;
  #modelsCache: { at: number; list: string[] } = { at: 0, list: [] };
  #inputMaxHeight = 8;
  #attachment = "";

  constructor(deps: AppDeps) {
    this.#deps = deps;
    this.configStore = deps.configStore;
    this.router = deps.router;
    this.store = deps.store;
    this.memory = deps.memory;
    this.autoBank = deps.autoBank;
    this.sessionBank = deps.sessionBank;
    this.session = deps.session;
    this.engine = deps.engine;
    this.#themeName = deps.configStore.value.ui.theme;
    this.theme = getTheme(this.#themeName);
    this.#colorMode = resolveColorMode(deps.configStore.value.ui.colorMode);
    this.#renderer = new TranscriptRenderer({
      theme: this.theme,
      width: 80,
      config: deps.configStore.value,
      expandedReasoning: this.#expandedReasoning,
      showIndices: true,
    });
    this.#screen = new Screen(process.stdout as never, process.stdin as never);
    this.#composer.history = this.#loadHistory();
  }

  // ---- CommandHost surface ---------------------------------------------

  get theme_(): Theme {
    return this.theme;
  }

  print(markdown: string, tone: Token = "fg"): void {
    const width = this.#screen.size().cols - 4;
    if (!markdown.trim()) {
      this.#log = [];
      this.#dirty = true;
      return;
    }
    const lines = renderMarkdown(markdown, {
      theme: this.theme,
      width: Math.max(20, width),
      tone,
      lineNumbers: this.configStore.value.ui.lineNumbers,
      codeWrap: this.configStore.value.ui.codeWrap,
      codeHeader: true,
    });
    const gutter = toCells([{ t: "▏ ", s: st(this.theme, "border") }]);
    for (const line of lines) this.#log.push([...gutter, ...line]);
    this.#log.push([]);
    this.#dirty = true;
  }

  notice(text: string, tone: NoticeTone = "info", ms = 4000): void {
    const entry: Notice = { text, tone, until: Date.now() + ms };
    this.#notices = [...this.#notices.filter((n) => n.until > Date.now() && n.text !== text).slice(-2), entry];
    this.#dirty = true;
  }

  openOverlay(state: OverlayState): void {
    this.#overlay = state;
    this.#dirty = true;
  }

  closeOverlay(): void {
    if (this.#overlay && this.pendingConfirm) {
      this.pendingConfirm();
      this.pendingConfirm = null;
    }
    this.#overlay = null;
    this.#overlayAccept = null;
    this.#overlayKey = null;
    this.#dirty = true;
  }

  confirm(title: string, prompt: string, onAccept: () => void): void {
    this.#overlay = {
      kind: "confirm",
      title,
      prompt,
      tone: "warn",
      onAcceptLabel: "delete",
      footer: "⏎ confirm · esc cancel",
    };
    this.#overlayAccept = () => {
      this.closeOverlay();
      onAccept();
    };
    this.#dirty = true;
  }

  newSession(opts: { title?: string } = {}): void {
    const session = this.store.create({
      home: this.store.home,
      model: this.session.meta.model,
      ...(this.session.meta.systemPrompt ? { systemPrompt: this.session.meta.systemPrompt } : {}),
      ...(opts.title ? { title: opts.title } : {}),
    });
    this.#activate(session);
  }

  switchSession(id: string): void {
    const session = this.store.load(id);
    if (!session) {
      this.notice("session not found", "error");
      return;
    }
    this.#activate(session);
  }

  sessions(): SessionSummary[] {
    return this.store.list();
  }

  setTheme(name: string): boolean {
    if (!THEMES[name]) return false;
    this.#themeName = name;
    this.theme = getTheme(name);
    this.#renderer.update({ theme: this.theme });
    this.#dirty = true;
    return true;
  }

  send(text: string): void {
    void this.#submit(text);
  }

  retry(): void {
    void this.#runTurn(() => this.engine.retry());
  }

  refresh(): void {
    this.#renderer.invalidate();
    this.#dirty = true;
  }

  exit(code = 0): void {
    this.#exitCode = code;
  }

  showHelp(): void {
    this.#overlay = {
      kind: "help",
      title: "kono — help",
      subtitle: `${COMMANDS.length} commands`,
      body: markdownForHelp(),
      scroll: 0,
      width: Math.min(84, this.#screen.size().cols - 4),
      footer: "↑↓ scroll · any key to close",
    };
    this.#dirty = true;
  }

  async listModels(): Promise<string[]> {
    if (Date.now() - this.#modelsCache.at < 300_000 && this.#modelsCache.list.length) return this.#modelsCache.list;
    try {
      const catalog = await this.router.models();
      const list = catalogModels(catalog).map((m) => m.id).sort();
      this.#modelsCache = { at: Date.now(), list };
      this.#online = true;
      return list;
    } catch {
      this.#online = false;
      return this.#modelsCache.list;
    }
  }

  async copyToClipboard(text: string): Promise<string> {
    return copyToClipboard(text, { write: (s) => process.stdout.write(s) });
  }

  async exportSession(format: "md" | "json", path?: string): Promise<string> {
    const target = resolve(path ?? `${safeFileName(this.session.meta.title)}.${format}`);
    const body = format === "json" ? this.store.exportJson(this.session) : this.session.toMarkdown();
    writeFileSync(target, body, "utf8");
    return target;
  }

  async importSession(path: string): Promise<void> {
    try {
      const json = readFileSync(resolve(path), "utf8");
      const session = this.store.importJson(json);
      this.#activate(session);
      this.notice(`imported ${session.meta.title}`, "ok");
    } catch (err) {
      this.notice(`import failed: ${(err as Error).message}`, "error");
    }
  }

  saveConfig(): void {
    this.configStore.save();
    this.#renderer.update({ config: this.configStore.value });
    this.#dirty = true;
  }

  reloadConfig(): void {
    this.router.setApiKey(this.configStore.value.router.apiKey);
    this.#renderer.update({ config: this.configStore.value });
    this.#colorMode = resolveColorMode(this.configStore.value.ui.colorMode);
    this.#dirty = true;
  }

  settingsSummary(): string {
    const cfg = this.configStore.value;
    const rows: string[] = ["### Settings", "", `Config file: \`${this.configStore.path}\``, ""];
    for (const [section, values] of Object.entries(cfg)) {
      if (typeof values !== "object" || values === null) continue;
      rows.push(`**${section}**`);
      for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
        const display = key === "apiKey" || key === "adminSecret" ? (value ? this.configStore.maskKey() : "—") : JSON.stringify(value);
        rows.push(`- \`${section}.${key}\` = \`${display}\``);
      }
      rows.push("");
    }
    return rows.join("\n");
  }

  // ---- lifecycle --------------------------------------------------------

  async run(): Promise<void> {
    this.#screen.start();
    this.#screen.setRaw(true);
    this.#screen.onResize(() => {
      this.#renderer.update({ width: this.#screen.size().cols });
      this.#dirty = true;
    });
    const offInput = this.#screen.onInput((chunk) => this.#onInput(chunk));

    this.#ticker = setInterval(() => {
      this.#spinnerFrame++;
      const hasNotices = this.#notices.some((n) => n.until > Date.now());
      if (hasNotices) this.#notices = this.#notices.filter((n) => n.until > Date.now());
      if (this.#dirty || this.#busy || hasNotices) this.#render();
    }, 80);

    const cleanup = () => {
      if (this.#ticker) clearInterval(this.#ticker);
      offInput();
      this.#screen.setRaw(false);
      this.#screen.stop();
    };
    process.on("uncaughtException", (err) => {
      cleanup();
      process.stderr.write(`\nkono crashed: ${err?.stack ?? err}\n`);
      process.exit(1);
    });

    this.#render();
    await new Promise<void>((resolvePromise) => {
      const check = setInterval(() => {
        if (this.#exitCode !== null) {
          clearInterval(check);
          resolvePromise();
        }
      }, 50);
    });
    cleanup();
    if (this.#exitCode && this.#exitCode !== 0) process.exitCode = this.#exitCode;
  }

  #activate(session: Session): void {
    this.session = session;
    this.engine = this.#deps.makeEngine(session);
    this.#live = null;
    this.#busy = false;
    this.#log = [];
    this.#scroll = 0;
    this.#follow = true;
    this.#expandedReasoning.clear();
    this.#highlight = "";
    this.#renderer.invalidate();
    this.#status = `session ${session.meta.id.slice(2, 8)}`;
    this.#dirty = true;
  }

  #loadHistory(): string[] {
    try {
      const path = `${this.store.home}/history.json`;
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as string[];
      return Array.isArray(parsed) ? parsed.slice(-200) : [];
    } catch {
      return [];
    }
  }

  #saveHistory(): void {
    try {
      writeFileSync(`${this.store.home}/history.json`, JSON.stringify(this.#composer.history.slice(-200)), { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  // ---- input ------------------------------------------------------------

  #onInput(chunk: string): void {
    const { keys, pending } = parseKeys(chunk, this.#pendingKeys);
    this.#pendingKeys = pending;
    for (const key of keys) {
      this.#handleKey(key);
      if (this.#exitCode !== null) return;
    }
    this.#dirty = true;
  }

  #handleKey(key: KeyEvent): void {
    // Quitting must work from anywhere, including inside an overlay.
    if (key.ctrl && key.key === "c") {
      this.#interrupt();
      return;
    }
    // Overlays capture the rest.
    if (this.#overlay && this.#handleOverlayKey(key)) return;

    if (key.key === "paste" && key.paste !== undefined) {
      this.#composer.insert(key.paste.replace(/\r\n?/g, "\n"));
      return;
    }

    if (key.ctrl && !key.alt) {
      switch (key.key) {
        case "d":
          if (this.#composer.isEmpty) this.exit(0);
          return;
        case "k":
        case "p":
          this.#openPalette();
          return;
        case "s":
          void this.#runCommand("/sessions");
          return;
        case "m":
          void this.#runCommand("/memory list");
          return;
        case "f":
          void this.#runCommand("/find");
          return;
        case "t":
          void this.#runCommand("/theme");
          return;
        case "o":
          void this.#runCommand("/model");
          return;
        case "n":
          this.newSession();
          return;
        case "r":
          this.#openHistory();
          return;
        case "y":
          void this.#copyLastBlock();
          return;
        case "g":
          this.retry();
          return;
        case "l":
          this.#screen.invalidate();
          this.#renderer.invalidate();
          this.#dirty = true;
          return;
        case "a":
          this.#composer.lineStart();
          return;
        case "e":
          this.#composer.lineEnd();
          return;
        case "u":
          this.#composer.killLine();
          return;
        case "w":
        case "backspace":
          this.#composer.deleteWordBack();
          return;
        case "j":
          this.#composer.insertNewline();
          return;
        case "left":
          this.#switchBranch(-1);
          return;
        case "right":
          this.#switchBranch(1);
          return;
        case "home":
          this.#scroll = 0;
          this.#follow = false;
          return;
        case "end":
          this.#follow = true;
          return;
        default:
          return;
      }
    }

    if (key.alt && key.key === "backspace") {
      this.#composer.deleteWordBack();
      return;
    }

    switch (key.key) {
      case "left":
        this.#composer.moveLeft();
        return;
      case "right":
        this.#composer.moveRight();
        return;
      case "up":
        if (key.alt) this.#scrollBy(-3);
        else if (this.#composer.isMultiline) this.#composer.moveVertical(-1, this.#inputWidth());
        else this.#composer.historyPrev();
        return;
      case "down":
        if (key.alt) this.#scrollBy(3);
        else if (this.#composer.isMultiline) this.#composer.moveVertical(1, this.#inputWidth());
        else this.#composer.historyNext();
        return;
      case "pgup":
        this.#scrollBy(-this.#viewportHeight());
        return;
      case "pgdn":
        this.#scrollBy(this.#viewportHeight());
        return;
      case "home":
        this.#composer.lineStart();
        return;
      case "end":
        this.#composer.lineEnd();
        return;
      case "backspace":
        this.#composer.backspace();
        return;
      case "delete":
        this.#composer.deleteForward();
        return;
      case "newline":
        this.#composer.insertNewline();
        return;
      case "enter": {
        if (key.alt) {
          this.#composer.insertNewline();
          return;
        }
        const suggestions = this.#suggestions();
        const typed = this.#composer.value.trim();
        // Enter runs an exact command name; it only completes when the user is
        // still typing a partial one.
        if (suggestions.length && typed.startsWith("/") && !suggestions.some((s0) => `/${s0.name}` === typed)) {
          const chosen = suggestions[this.#suggestionCursor % suggestions.length]!;
          this.#composer.set(`/${chosen.name} `);
          this.#suggestionCursor = 0;
          return;
        }
        void this.#submit(this.#composer.value);
        return;
      }
      case "tab": {
        const suggestions = this.#suggestions();
        if (suggestions.length) {
          const chosen = suggestions[this.#suggestionCursor % suggestions.length]!;
          this.#composer.set(`/${chosen.name} `);
          this.#suggestionCursor = (this.#suggestionCursor + 1) % suggestions.length;
          return;
        }
        this.#toggleReasoning();
        return;
      }
      case "escape":
        if (this.#busy) {
          this.engine.abort();
          this.notice("stopping…", "warn", 1500);
        } else if (!this.#composer.isEmpty) {
          this.#composer.clear();
        } else if (this.#highlight) {
          this.#highlight = "";
          this.#renderer.update({ highlightTerm: "" });
        }
        return;
      case "f1":
        this.showHelp();
        return;
      default:
        break;
    }

    if (key.text && !key.ctrl && !key.alt) {
      if (key.text === "?" && this.#composer.isEmpty) {
        this.showHelp();
        return;
      }
      this.#composer.insert(key.text);
      if (key.text === "/") this.#suggestionCursor = 0;
      if (this.#composer.slashPrefix() === null) this.#suggestionCursor = 0;
      return;
    }
  }

  #suggestionCursor = 0;

  #suggestions(): Array<{ name: string; summary: string }> {
    const prefix = this.#composer.slashPrefix();
    if (prefix === null) return [];
    return commandSuggestions(prefix).map((c) => ({ name: c.name, summary: c.summary }));
  }

  #interrupt(): void {
    const now = Date.now();
    if (this.#busy) {
      this.engine.abort();
      this.#lastInterrupt = now;
      this.notice("stopping…", "warn", 1500);
      return;
    }
    if (!this.#composer.isEmpty) {
      this.#composer.clear();
      this.#lastInterrupt = now;
      return;
    }
    if (now - this.#lastInterrupt < 1500) {
      this.exit(0);
      return;
    }
    this.#lastInterrupt = now;
    this.notice("press ctrl+c again to quit", "warn", 1500);
  }

  #scrollBy(delta: number): void {
    const view = this.#renderer.render(this.session, this.#live);
    const height = view.height + this.#log.length;
    const viewport = this.#viewportHeight();
    const maxScroll = Math.max(0, height - viewport);
    const current = this.#follow ? maxScroll : Math.min(this.#scroll, maxScroll);
    const next = Math.max(0, Math.min(maxScroll, current + delta));
    this.#scroll = next;
    this.#follow = next >= maxScroll;
    this.#dirty = true;
  }

  #toggleReasoning(): void {
    const path = this.session.path();
    const target = [...path].reverse().find((m) => m.reasoning) ?? path[path.length - 1];
    if (!target) return;
    if (this.#expandedReasoning.has(target.id)) this.#expandedReasoning.delete(target.id);
    else this.#expandedReasoning.add(target.id);
    this.#renderer.invalidate(target.id);
    this.#dirty = true;
  }

  #switchBranch(direction: number): void {
    const path = this.session.path();
    const last = path[path.length - 1];
    if (!last) return;
    const siblings = this.session.siblings(last.id);
    if (siblings.length < 2) return;
    const idx = siblings.indexOf(last.id);
    const next = siblings[(idx + direction + siblings.length) % siblings.length]!;
    this.session.setLeaf(next);
    this.#renderer.invalidate();
    this.notice(`branch ${(idx + direction + siblings.length) % siblings.length + 1}/${siblings.length}`, "info", 2000);
  }

  #openPalette(): void {
    const items: OverlayItem[] = COMMANDS.map((c) => ({
      id: c.name,
      label: `/${c.name}`,
      hint: c.summary,
      badge: c.category,
      detail: c.usage ?? "",
      tone: c.category === "memory" ? "memory" : c.category === "context" ? "summary" : c.category === "model" ? "accent2" : "fg",
      ...(c.keys ? { meta: c.keys } : {}),
    }));
    // Dynamic entries: jump to a message.
    const path = this.session.path();
    for (let i = 0; i < path.length; i++) {
      const msg = path[i]!;
      items.push({
        id: `__jump:${msg.id}`,
        label: `#${i + 1} ${msg.content.replace(/\s+/g, " ").slice(0, 48) || "(empty)"}`,
        hint: msg.role,
        badge: "jump",
        tone: "muted",
      });
    }
    this.#overlay = {
      kind: "list",
      title: "Command palette",
      subtitle: "commands and messages",
      query: "",
      items,
      cursor: 0,
      footer: "⏎ run · type to filter · esc close",
    };
    this.#overlayAccept = (item) => {
      this.closeOverlay();
      if (item.id.startsWith("__jump:")) {
        this.#jumpTo(item.id.slice(7));
        return;
      }
      void this.#runCommand(`/${item.id}`);
    };
    this.#dirty = true;
  }

  #openHistory(): void {
    const items = [...this.#composer.history].reverse().map((h, i) => ({
      id: String(i),
      label: h.replace(/\s+/g, " ").slice(0, 80),
      hint: h.length > 80 ? `${h.length} chars` : "",
    }));
    this.#overlay = { kind: "list", title: OVERLAY_TITLES.history!, query: "", items, cursor: 0, footer: "⏎ insert · esc close" };
    this.#overlayAccept = (item) => {
      this.closeOverlay();
      this.#composer.setFromHistory(this.#composer.history[this.#composer.history.length - 1 - Number(item.id)] ?? "");
    };
    this.#dirty = true;
  }

  #jumpTo(messageId: string): void {
    const view = this.#renderer.render(this.session, this.#live);
    const line = view.index.get(messageId);
    if (line === undefined) return;
    const viewport = this.#viewportHeight();
    const maxScroll = Math.max(0, view.height + this.#log.length - viewport);
    this.#scroll = Math.min(maxScroll, line);
    this.#follow = false;
    this.#dirty = true;
  }

  async #copyLastBlock(): Promise<void> {
    void this.#runCommand("/copy");
  }

  // ---- overlay keys -----------------------------------------------------

  #handleOverlayKey(key: KeyEvent): boolean {
    const overlay = this.#overlay;
    if (!overlay) return false;
    if (this.#overlayKey && this.#overlayKey(key)) return true;

    if (key.key === "escape") {
      this.closeOverlay();
      return true;
    }
    if (overlay.kind === "help" || overlay.kind === "stats" || overlay.kind === "peek") {
      if (key.key === "up") {
        overlay.scroll = Math.max(0, (overlay.scroll ?? 0) - 1);
        this.#dirty = true;
        return true;
      }
      if (key.key === "down") {
        overlay.scroll = (overlay.scroll ?? 0) + 1;
        this.#dirty = true;
        return true;
      }
      if (key.key === "pgup") {
        overlay.scroll = Math.max(0, (overlay.scroll ?? 0) - 10);
        this.#dirty = true;
        return true;
      }
      if (key.key === "pgdn") {
        overlay.scroll = (overlay.scroll ?? 0) + 10;
        this.#dirty = true;
        return true;
      }
      if (key.key === "enter" || (key.text && !key.ctrl)) {
        this.closeOverlay();
        return true;
      }
      return true;
    }
    if (overlay.kind === "confirm") {
      if (key.key === "enter") {
        const accept = this.#overlayAccept;
        this.#overlayAccept = null;
        this.pendingConfirm = null;
        this.#overlay = null;
        if (accept) accept({ id: "confirm", label: "confirm" });
        this.#dirty = true;
        return true;
      }
      return true;
    }

    // list overlays
    if (key.key === "up" || (key.key === "p" && key.ctrl)) {
      moveOverlayCursor(overlay, -1);
      this.#dirty = true;
      return true;
    }
    if (key.key === "down" || (key.key === "n" && key.ctrl)) {
      moveOverlayCursor(overlay, 1);
      this.#dirty = true;
      return true;
    }
    if (key.key === "pgup") {
      moveOverlayCursor(overlay, -8);
      this.#dirty = true;
      return true;
    }
    if (key.key === "pgdn") {
      moveOverlayCursor(overlay, 8);
      this.#dirty = true;
      return true;
    }
    if (key.key === "enter") {
      const items = filteredItems(overlay);
      const item = items[overlay.cursor ?? 0];
      if (!item) return true;
      const accept = this.#overlayAccept;
      const title = overlay.title;
      this.#overlay = null;
      this.#overlayAccept = null;
      this.#overlayKey = null;
      if (accept) accept(item);
      else this.#defaultAccept(item, title);
      this.#dirty = true;
      return true;
    }
    if (key.key === "backspace") {
      if (overlay.query !== undefined) {
        overlay.query = overlay.query.slice(0, -1);
        overlay.cursor = 0;
        this.#dirty = true;
      }
      return true;
    }
    // Overlay-specific single-key actions.
    if (overlay.kind === "list" && key.text && !key.ctrl && !key.alt) {
      const ch = key.text;
      if (ch === "d" || ch === "r" || ch === "s" || ch === "*") {
        if (this.#overlayAction(ch, overlay)) {
          this.#dirty = true;
          return true;
        }
      }
      if (overlay.query !== undefined) {
        overlay.query += ch;
        overlay.cursor = 0;
        this.#dirty = true;
        return true;
      }
    }
    return true;
  }

  #overlayAction(ch: string, overlay: OverlayState): boolean {
    const item = filteredItems(overlay)[overlay.cursor ?? 0];
    if (!item) return false;
    if (overlay.title === OVERLAY_TITLES.sessions) {
      if (ch === "d") {
        this.confirm("Delete session", `Delete “${item.label}” permanently?`, () => {
          this.store.delete(item.id);
          if (item.id === this.session.id) {
            const next = this.store.latest();
            if (next) this.#activate(next);
          }
          this.notice("session deleted", "ok");
        });
        return true;
      }
      if (ch === "r") {
        this.closeOverlay();
        this.#composer.set(`/rename ${item.label}`);
        return true;
      }
      if (ch === "*" || ch === "s") {
        const session = this.store.load(item.id);
        if (session) {
          session.patchMeta({ starred: !session.meta.starred });
          this.notice(session.meta.starred ? "starred" : "unstarred", "ok");
          void this.#runCommand("/sessions");
        }
        return true;
      }
    }
    if (overlay.title === OVERLAY_TITLES.memory) {
      if (ch === "d") {
        for (const bank of this.memory.banks) {
          if (bank.find(item.id)) bank.remove(item.id);
        }
        this.closeOverlay();
        this.notice("memory forgotten", "ok");
        return true;
      }
      if (ch === "p" || ch === "s") {
        for (const bank of this.memory.banks) {
          const found = bank.find(item.id);
          if (found) bank.update(found.id, { pinned: !found.pinned });
        }
        this.closeOverlay();
        this.notice("pin toggled", "ok");
        return true;
      }
    }
    return false;
  }

  #defaultAccept(item: OverlayItem, title: string): void {
    if (title === OVERLAY_TITLES.themes) {
      if (!this.setTheme(item.id)) return;
      this.configStore.value.ui.theme = item.id;
      this.saveConfig();
      this.notice(`theme → ${item.id}`, "ok");
      return;
    }
    if (title === OVERLAY_TITLES.sessions) {
      this.switchSession(item.id);
      return;
    }
    if (title === OVERLAY_TITLES.models) {
      this.session.patchMeta({ model: item.id });
      this.configStore.value.model.default = item.id;
      this.saveConfig();
      this.notice(`model → ${item.id}`, "ok");
      return;
    }
    if (title === OVERLAY_TITLES.memory) {
      for (const bank of this.memory.banks) {
        const found = bank.find(item.id);
        if (found) bank.update(found.id, { pinned: !found.pinned });
      }
      this.notice("pin toggled", "ok");
      return;
    }
    if (title === OVERLAY_TITLES.jump) {
      this.#jumpTo(item.id);
    }
  }

  // ---- commands & turns -------------------------------------------------

  async #runCommand(raw: string): Promise<void> {
    const parsed = parseCommand(raw);
    if (!parsed) return;
    const command = findCommand(parsed.name);
    if (!command) {
      this.notice(`unknown command /${parsed.name} — try /help`, "error");
      return;
    }
    try {
      await command.run(this, parsed.args, raw);
    } catch (err) {
      this.notice(`/${command.name} failed: ${(err as Error).message}`, "error", 6000);
    }
    this.#dirty = true;
  }

  async #submit(text: string): Promise<void> {
    const value = text.trim();
    if (!value) return;
    this.#composer.remember(value);
    this.#saveHistory();
    this.#composer.clear();
    this.#suggestionCursor = 0;

    if (value.startsWith("/")) {
      await this.#runCommand(value);
      return;
    }
    this.#follow = true;
    this.#scroll = 0;
    await this.#runTurn(() => this.engine.send(value));
  }

  async #runTurn(factory: () => AsyncGenerator<import("../core/engine.ts").EngineEvent>): Promise<void> {
    if (this.#busy) {
      this.notice("still generating — esc to stop", "warn");
      return;
    }
    this.#busy = true;
    this.#status = "generating";
    this.#degraded = false;
    const live: LiveTurn = { id: "pending", content: "", reasoning: "", toolCalls: [], startedAt: Date.now() };
    this.#live = live;
    this.#dirty = true;

    try {
      for await (const ev of factory()) {
        switch (ev.type) {
          case "start":
            live.id = ev.message.id;
            this.#renderer.invalidate();
            break;
          case "context":
            this.#lastStats = ev.stats;
            if (ev.stats.droppedMessages > 0) {
              this.notice(`context trimmed: dropped ${ev.stats.droppedMessages} old messages`, "warn", 6000);
            }
            break;
          case "compacting":
            this.#status = `compacting ${ev.count} messages…`;
            break;
          case "compacted":
            this.#status = "generating";
            this.notice(`compacted ${ev.count} messages via ${ev.via}`, "ok", 5000);
            this.#renderer.invalidate();
            break;
          case "routing":
            live.routing = ev.message.replace(/^routing\s*/, "");
            break;
          case "reasoning":
            live.reasoning += ev.delta;
            break;
          case "delta":
            live.content += ev.delta;
            live.routing = undefined;
            break;
          case "tool": {
            const existing = live.toolCalls.find((c) => c.name === ev.call.name && c.arguments === ev.call.arguments);
            if (existing) Object.assign(existing, ev.call);
            else live.toolCalls.push({ ...ev.call });
            break;
          }
          case "checkpoint":
            live.id = ev.message.id;
            break;
          case "telemetry":
            this.#online = true;
            if (ev.telemetry.degraded) this.#degraded = true;
            break;
          case "done":
            this.#status = "ready";
            this.#online = true;
            break;
          case "error": {
            const info = explainError(ev.error);
            this.#status = "error";
            if (ev.error.status === 401) this.#online = false;
            this.notice(`${info.message}${info.hint ? ` — ${info.hint}` : ""}`, "error", 9000);
            break;
          }
          case "memory":
            if (ev.added.length) {
              this.notice(`✦ remembered: ${ev.added[0]!.text.slice(0, 70)}${ev.added.length > 1 ? ` (+${ev.added.length - 1})` : ""}`, "ok", 6000);
            }
            break;
          case "title":
            this.#dirty = true;
            break;
          default:
            break;
        }
        this.#dirty = true;
      }
    } catch (err) {
      this.notice(`turn failed: ${(err as Error).message}`, "error", 8000);
    } finally {
      this.#busy = false;
      this.#live = null;
      this.#renderer.invalidate();
      this.#status = "ready";
      this.#dirty = true;
      if (this.configStore.value.ui.bellOnDone && !this.#follow) this.#screen.bell();
      this.session.saveMeta();
    }
  }

  // ---- rendering --------------------------------------------------------

  /** First-run screen: brand, quick start, key status and a few commands. */
  #welcomeLines(cols: number, viewport: number): Cell[][] {
    const theme = this.theme;
    const out: Cell[][] = [];
    const width = Math.min(76, cols - 4);
    const pad = Math.max(0, Math.floor((cols - width) / 2));
    const indent = blankCells(pad, null);
    const push = (cells: Cell[]) => out.push([...indent, ...sliceCells(cells, 0, width)]);

    push(toCells([{ t: "◈ kono", s: st(theme, "accent", { bold: true }) }]));
    push(toCells([{ t: "stateful terminal chat for nokey-router", s: st(theme, "muted") }]));
    out.push([]);
    const hasKey = this.router.hasKey;
    push(
      toCells([
        { t: hasKey ? "● " : "○ ", s: hasKey ? st(theme, "ok") : st(theme, "warn") },
        { t: hasKey ? "authenticated" : "no API key ", s: hasKey ? st(theme, "muted") : st(theme, "warn") },
        ...(hasKey
          ? [{ t: ` · ${this.configStore.maskKey()}`, s: st(theme, "faint") }]
          : [{ t: " — run /key <ROUTER_API_KEY>", s: st(theme, "faint") }]),
      ]),
    );
    push(toCells([{ t: `router ${this.configStore.value.router.baseUrl}`, s: st(theme, "faint") }]));
    out.push([]);
    push(toCells([{ t: "Try", s: st(theme, "h2", { bold: true }) }]));
    for (const [keys, text] of [
      ["⏎", "type a question and send it"],
      ["/", "browse commands (tab completes, enter runs)"],
      ["ctrl+k", "command palette · ctrl+s sessions · ctrl+m memory"],
      ["?", "all shortcuts"],
    ] as Array<[string, string]>) {
      push(
        toCells([
          { t: "  ", s: null },
          { t: keys.padEnd(9), s: { fg: theme.palette.bg, bg: theme.palette.accent, bold: true } },
          { t: ` ${text}`, s: st(theme, "muted") },
        ]),
      );
    }
    out.push([]);
    const memories = this.memory.stats();
    push(
      toCells([
        { t: `${memories.total} memories`, s: st(theme, "memory") },
        { t: ` · ${this.session.meta.model}`, s: st(theme, "accent2") },
        { t: ` · theme ${theme.name}`, s: st(theme, "faint") },
      ]),
    );

    // Vertically centre a little above the composer.
    const top = Math.max(0, Math.floor((viewport - out.length) / 2) - 1);
    const padded: Cell[][] = [];
    for (let i = 0; i < top; i++) padded.push([]);
    padded.push(...out);
    return padded;
  }

  #inputWidth(): number {
    return Math.max(10, this.#screen.size().cols - 4);
  }

  #viewportHeight(): number {
    const { rows } = this.#screen.size();
    const composer = this.#composerHeight();
    return Math.max(3, rows - 1 - composer - 1);
  }

  #composerHeight(): number {
    const view = this.#composer.view(this.#inputWidth());
    const lines = Math.min(this.#inputMaxHeight, Math.max(1, view.lines.length));
    const suggestions = this.#suggestions().length ? Math.min(5, this.#suggestions().length) : 0;
    return 1 + lines + 1 + suggestions;
  }

  #render(): void {
    const { cols, rows } = this.#screen.size();
    this.#renderer.update({ width: cols, config: this.configStore.value, highlightTerm: this.#highlight });
    const ansi = (cells: Cell[]) => lineToAnsi(cells, { colorMode: this.#colorMode, hyperlinks: true });

    const view = this.#renderer.render(this.session, this.#live);
    const composerHeight = this.#composerHeight();
    const viewport = Math.max(3, rows - 1 - composerHeight - 1);
    const content: Cell[][] = [...view.lines, ...this.#log];
    const total = content.length;
    const maxScroll = Math.max(0, total - viewport);
    if (this.#follow) this.#scroll = maxScroll;
    else this.#scroll = Math.min(this.#scroll, maxScroll);
    const start = Math.max(0, Math.min(this.#scroll, maxScroll));

    const lines: string[] = [];
    const headerState = {
      title: this.session.meta.title,
      model: this.session.meta.model,
      ...(this.#lastStats ? { context: this.#lastStats } : {}),
      memoryCount: this.memory.stats().total,
      sessionId: this.session.meta.id,
      online: this.#online,
      busy: this.#busy,
      theme: this.theme,
      config: this.configStore.value,
      width: cols,
      live: Boolean(this.#live),
    };
    lines.push(ansi(renderHeader(headerState)));

    if (this.#overlay) {
      const overlayLines = renderOverlay(this.#overlay, { theme: this.theme, cols, rows: viewport + 2 });
      const top = Math.max(0, Math.floor((viewport - overlayLines.length) / 2));
      for (let i = 0; i < viewport; i++) {
        const idx = i - top;
        const overlayLine = idx >= 0 && idx < overlayLines.length ? overlayLines[idx]! : null;
        if (overlayLine) {
          const leftPad = Math.max(0, Math.floor((cols - cellsWidth(overlayLine)) / 2));
          lines.push(ansi([...blankCells(leftPad), ...overlayLine]));
        } else {
          const bgIndex = start + i;
          const row = content[bgIndex];
          lines.push(row ? ansi(sliceCells(row, 0, cols)) : "");
        }
      }
    } else {
      if (content.length === 0) {
        const welcome = this.#welcomeLines(cols, viewport);
        for (let i = 0; i < viewport; i++) lines.push(welcome[i] ? ansi(welcome[i]!) : "");
      } else {
        for (let i = 0; i < viewport; i++) {
          const row = content[start + i];
          lines.push(row ? ansi(sliceCells(row, 0, cols)) : "");
        }
      }
    }

    // Composer
    const viewEditor = this.#composer.view(this.#inputWidth());
    this.#composer.clampScroll(viewEditor.row, this.#inputMaxHeight);
    const suggestions = this.#suggestions();
    const input = renderInput({
      theme: this.theme,
      width: cols,
      lines: viewEditor.lines,
      row: viewEditor.row,
      col: viewEditor.col,
      scroll: this.#composer.scroll,
      maxHeight: this.#inputMaxHeight,
      suggestions: suggestions.map((s) => ({ label: `/${s.name}`, hint: s.summary })),
      suggestionIndex: suggestions.length ? this.#suggestionCursor % suggestions.length : 0,
      placeholder: this.#busy ? "generating… (esc to stop)" : "ask anything, or type / for commands",
      ...(this.#attachment ? { attachment: this.#attachment } : {}),
    });
    for (const row of input.cells) lines.push(ansi(sliceCells(row, 0, cols)));

    const notice = this.#notices.at(-1);
    const footerState = {
      theme: this.theme,
      width: cols,
      busy: this.#busy,
      spinner: spin(this.#spinnerFrame),
      status: this.#status,
      notices: notice && notice.until > Date.now() ? [notice.text] : [],
      hints: ["? help", "ctrl+k palette", "ctrl+s sessions", "ctrl+m memory", "ctrl+o model"],
      ...(this.#lastStats ? { context: this.#lastStats } : {}),
      keysConfigured: this.router.hasKey,
      degraded: this.#degraded,
      streaming: this.#busy,
      queue: 0,
    };
    lines.push(ansi(renderFooter(footerState)));

    // Pad/trim to exactly `rows`.
    while (lines.length < rows) lines.push("");
    lines.length = rows;

    let cursor: { row: number; col: number } | null = null;
    if (!this.#overlay) {
      const inputTop = 1 + viewport;
      if (input.cursor) cursor = { row: inputTop + input.cursor.row, col: input.cursor.col };
      if (this.#composer.isEmpty) cursor = { row: inputTop + 1, col: 4 };
    }
    this.#screen.paint(lines, cursor ?? undefined);
    this.#dirty = false;
  }
}

function resolveColorMode(setting: string): ColorMode {
  if (setting === "auto") return detectColorMode(process.env, process.stdout.isTTY === true);
  return setting as ColorMode;
}


