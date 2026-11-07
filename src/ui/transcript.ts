/**
 * Transcript composition.
 *
 * Messages become colour-coded rows: a role gutter (glyph + label + index +
 * model/lane), a rendered body, and a telemetry footer. Rendered messages are
 * cached by id+version so streaming only re-renders the live message, and a
 * 200-message session stays instant on every keypress.
 */
import type { Cell, Style } from "../util/cells.ts";
import { blankCells, cellsWidth, padCells, sliceCells, toCells, wrapCells } from "../util/cells.ts";
import { st } from "./theme.ts";
import type { Theme, Token } from "./theme.ts";
import type { Config } from "../store/config.ts";
import type { Message, Session, ToolCallRecord } from "../store/session.ts";
import { renderMarkdown } from "../render/markdown-render.ts";
import { fmtDuration } from "../util/time.ts";
import { fmtTokens } from "../util/tokens.ts";

export interface LiveTurn {
  id: string;
  content: string;
  reasoning: string;
  toolCalls: ToolCallRecord[];
  routing?: string;
  startedAt: number;
  aborted?: boolean;
}

export interface TranscriptOptions {
  theme: Theme;
  width: number;
  config: Config;
  /** Message ids whose reasoning is expanded (overrides config default). */
  expandedReasoning: Set<string>;
  /** Search term to highlight. */
  highlightTerm?: string;
  /** Message id selected for actions. */
  selectedId?: string;
  /** Show message indices (used by /copy N, /retry N). */
  showIndices?: boolean;
}

export interface RenderedTranscript {
  lines: Cell[][];
  /** First line index of each message. */
  index: Map<string, number>;
  /** Total content height. */
  height: number;
}

const INDENT = 2;

const ROLE_META: Record<
  Message["role"],
  { token: Token; label: string; glyphKey: "user" | "assistant" | "reasoning" | "tool" | "toolResult" | "system" | "summary" | "memory" | "error" }
> = {
  user: { token: "user", label: "you", glyphKey: "user" },
  assistant: { token: "assistant", label: "assistant", glyphKey: "assistant" },
  tool: { token: "toolResult", label: "tool result", glyphKey: "toolResult" },
  system: { token: "system", label: "system", glyphKey: "system" },
  summary: { token: "summary", label: "summary", glyphKey: "summary" },
};

export class TranscriptRenderer {
  #cache = new Map<string, { key: string; lines: Cell[][] }>();
  #opts: TranscriptOptions;
  #counter = 0;

  constructor(opts: TranscriptOptions) {
    this.#opts = opts;
  }

  get options(): TranscriptOptions {
    return this.#opts;
  }

  update(patch: Partial<TranscriptOptions>): void {
    const relevantChanged =
      (patch.width !== undefined && patch.width !== this.#opts.width) ||
      (patch.theme !== undefined && patch.theme !== this.#opts.theme) ||
      (patch.config !== undefined && patch.config !== this.#opts.config) ||
      (patch.highlightTerm !== undefined && patch.highlightTerm !== this.#opts.highlightTerm) ||
      (patch.showIndices !== undefined && patch.showIndices !== this.#opts.showIndices);
    this.#opts = { ...this.#opts, ...patch };
    if (relevantChanged) this.#cache.clear();
  }

  invalidate(id?: string): void {
    if (id) this.#cache.delete(id);
    else this.#cache.clear();
  }

  render(session: Session, live?: LiveTurn | null): RenderedTranscript {
    const path = session.path();
    const lines: Cell[][] = [];
    const index = new Map<string, number>();
    this.#counter = 0;

    for (let i = 0; i < path.length; i++) {
      const msg = path[i]!;
      index.set(msg.id, lines.length);
      const isLive = live?.id === msg.id;
      const rendered = isLive ? this.#renderLive(msg, live, i, path.length) : this.#renderMessage(msg, i, path.length, session);
      lines.push(...rendered);
      if (i < path.length - 1) lines.push([]);
    }

    if (live && !path.some((m) => m.id === live.id)) {
      // The live turn is not in the tree yet (first token before checkpoint).
      index.set(live.id, lines.length);
      const synthetic: Message = {
        id: live.id,
        parentId: null,
        role: "assistant",
        content: live.content,
        createdAt: live.startedAt,
      };
      lines.push(...this.#renderLive(synthetic, live, path.length, path.length + 1));
    }

    return { lines, index, height: lines.length };
  }

  #key(msg: Message, total: number): string {
    return [
      msg.role,
      msg.content.length,
      msg.content.slice(-24),
      msg.reasoning?.length ?? 0,
      msg.toolCalls?.length ?? 0,
      msg.error ?? "",
      msg.feedback ?? "",
      msg.model ?? "",
      msg.pinned ? "p" : "",
      msg.updatedAt ?? 0,
      this.#opts.width,
      this.#opts.theme.name,
      this.#opts.config.ui.showReasoning,
      this.#opts.config.ui.lineNumbers ? "n" : "",
      this.#opts.config.ui.codeWrap ? "w" : "",
      this.#opts.expandedReasoning.has(msg.id) ? "x" : "",
      this.#opts.highlightTerm ?? "",
      this.#opts.showIndices ? "i" : "",
      total,
    ].join("|");
  }

  #renderMessage(msg: Message, position: number, total: number, session: Session): Cell[][] {
    const key = this.#key(msg, total);
    const hit = this.#cache.get(msg.id);
    if (hit && hit.key === key) return hit.lines;
    const rendered = this.#compose(msg, position, total, session.siblings(msg.id).length, undefined);
    this.#cache.set(msg.id, { key, lines: rendered });
    return rendered;
  }

  #renderLive(msg: Message, live: LiveTurn, position: number, total: number): Cell[][] {
    const merged: Message = {
      ...msg,
      content: live.content,
      reasoning: live.reasoning || undefined,
      toolCalls: live.toolCalls.length ? live.toolCalls : msg.toolCalls,
    };
    return this.#compose(merged, position, total, 0, live);
  }

  #compose(msg: Message, position: number, total: number, siblingCount: number, live?: LiveTurn): Cell[][] {
    const { theme, width, config } = this.#opts;
    const meta = ROLE_META[msg.role];
    this.#counter++;
    const isSystem = msg.role === "system";
    const glyph = theme.glyphs[meta.glyphKey];
    const headStyle: Style = st(theme, meta.token, { bold: true });
    const dimStyle = st(theme, "faint");

    if (msg.role === "system" && msg.systemKind === "compaction") {
      // Compaction summaries render as summaries.
      return this.#compose({ ...msg, role: "summary" }, position, total, siblingCount, live);
    }

    const head: Cell[] = [];
    head.push(...toCells([{ t: `${glyph} `, s: headStyle }]));
    head.push(...toCells([{ t: meta.label, s: headStyle }]));

    const model = msg.telemetry?.model ?? msg.model;
    if (model && (msg.role === "assistant" || msg.role === "summary")) {
      head.push(...toCells([{ t: " · ", s: dimStyle }]));
      head.push(...toCells([{ t: model, s: st(theme, "muted") }]));
    }
    if (msg.role === "user" && config.ui.showTimestamps) {
      head.push(...toCells([{ t: " · ", s: dimStyle }]));
      const clock = new Date(msg.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      head.push(...toCells([{ t: clock, s: dimStyle }]));
    }

    if (this.#opts.showIndices !== false) {
      head.push(...toCells([{ t: "  ", s: dimStyle }]));
      head.push(...toCells([{ t: `#${position + 1}`, s: st(theme, "faint") }]));
    }

    if (siblingCount > 1) {
      head.push(...toCells([{ t: "  ", s: dimStyle }]));
      head.push(...toCells([{ t: `⑂ ${siblingCount} branches`, s: st(theme, "accent2") }]));
    }
    if (msg.pinned) {
      head.push(...toCells([{ t: "  ", s: dimStyle }]));
      head.push(...toCells([{ t: "📌 pinned", s: st(theme, "warn") }]));
    }
    if (msg.feedback === "up") head.push(...toCells([{ t: "  ", s: dimStyle }]), ...toCells([{ t: "▲ rated", s: st(theme, "ok") }]));
    if (msg.feedback === "down") head.push(...toCells([{ t: "  ", s: dimStyle }]), ...toCells([{ t: "▼ rated", s: st(theme, "error") }]));

    if (this.#opts.selectedId === msg.id) {
      const padded = padCells(head, width, { bg: theme.palette.selectionBg });
      head.length = 0;
      head.push(...padded);
    }

    const out: Cell[][] = [head];
    const bodyWidth = Math.max(12, width - INDENT);
    const indent = blankCells(INDENT, null);

    const mdOpts = {
      theme,
      width: bodyWidth,
      tone: meta.token,
      lineNumbers: config.ui.lineNumbers,
      codeWrap: config.ui.codeWrap,
      codeHeader: true,
      ...(this.#opts.highlightTerm ? { highlightTerm: this.#opts.highlightTerm } : {}),
    };

    // ---- reasoning -----------------------------------------------------
    if (msg.reasoning && config.ui.showReasoning !== "hidden") {
      const expanded = this.#opts.expandedReasoning.has(msg.id);
      const showExpanded = expanded || (config.ui.showReasoning === "expanded" && !this.#opts.expandedReasoning.has(`!${msg.id}`));
      const chars = msg.reasoning.trim().length;
      if (showExpanded) {
        const rLines = renderMarkdown(msg.reasoning, {
          ...mdOpts,
          tone: "reasoning",
          maxCodeLines: 24,
        });
        for (const line of rLines) out.push([...indent, ...line]);
        out.push([...indent, ...toCells([{ t: `◇ reasoning · ${chars} chars — click Tab to collapse`, s: st(theme, "reasoning", { dim: true, italic: true }) }])]);
      } else {
        out.push([
          ...indent,
          ...toCells([{ t: `${theme.glyphs.reasoning} thinking `, s: st(theme, "reasoning") }]),
          ...toCells([{ t: `· ${chars} chars · Tab to expand`, s: st(theme, "faint") }]),
        ]);
      }
    }

    // ---- body ----------------------------------------------------------
    if (msg.content.trim()) {
      const body = msg.role === "summary" ? `∑ ${msg.content}` : msg.content;
      const bodyLines = renderMarkdown(body, mdOpts);
      for (const line of bodyLines) out.push([...indent, ...line]);
    } else if (msg.role === "assistant" && !live && !msg.error) {
      out.push([...indent, ...toCells([{ t: "(empty response)", s: st(theme, "faint", { italic: true }) }])]);
    }

    if (live && !live.aborted) {
      // Blinking block cursor at the end of the streaming answer.
      const cursor = toCells([{ t: "▊", s: st(theme, "cursor") }]);
      if (msg.content) {
        const last = out[out.length - 1];
        if (last) last.push(...cursor);
      } else {
        out.push([...indent, ...cursor]);
      }
    }

    // ---- tool calls ----------------------------------------------------
    if (msg.toolCalls?.length) {
      for (const call of msg.toolCalls) {
        out.push([
          ...indent,
          ...toCells([{ t: `${theme.glyphs.tool} `, s: st(theme, "tool", { bold: true }) }]),
          ...toCells([{ t: call.name || "tool", s: st(theme, "tool", { bold: true }) }]),
          ...toCells([{ t: call.ok === false ? "  failed" : "", s: st(theme, "error") }]),
        ]);
        const args = prettyJson(call.arguments);
        const argLines = renderMarkdown(`\`\`\`json\n${args}\n\`\`\``, { ...mdOpts, tone: "tool" });
        for (const line of argLines) out.push([...indent, ...blankCells(2, null), ...line]);
        if (call.result) {
          const resultLines = renderMarkdown(truncate(call.result, 1200), { ...mdOpts, tone: "toolResult" });
          for (const line of resultLines) out.push([...indent, ...blankCells(2, null), ...line]);
        }
      }
    }

    if (msg.role === "tool" && msg.toolName) {
      out.push([...indent, ...toCells([{ t: `↳ ${msg.toolName}`, s: st(theme, "toolResult") }])]);
    }

    // ---- error ---------------------------------------------------------
    if (msg.error) {
      const errStyle = st(theme, "error");
      const errLines = wrapCells(toCells([{ t: msg.error, s: errStyle }]), bodyWidth);
      for (const line of errLines) out.push([...indent, ...toCells([{ t: `${theme.glyphs.error} `, s: errStyle }]), ...line]);
      if (/401|unauthor/i.test(msg.error)) {
        out.push([...indent, ...blankCells(2, null), ...toCells([{ t: "hint: /key <ROUTER_API_KEY>", s: st(theme, "warn") }])]);
      }
    }

    // ---- memory + telemetry -------------------------------------------
    const footer = this.#footer(msg, live);
    if (footer.length) out.push([...indent, ...sliceCells(footer, 0, bodyWidth)]);

    if (live) {
      const routing = live.routing?.trim();
      if (routing) {
        out.push([...indent, ...toCells([{ t: `⋯ ${routing}`, s: st(theme, "accent3", { dim: true, italic: true }) }])]);
      }
    }

    return out;
  }

  #footer(msg: Message, live?: LiveTurn): Cell[] {
    const { theme, config } = this.#opts;
    if (!config.ui.showTelemetry) return [];
    const parts: Cell[] = [];
    const sep = () => parts.push(...toCells([{ t: " · ", s: st(theme, "faint") }]));
    const tel = msg.telemetry;

    if (live && !tel?.totalMs) {
      const elapsed = Date.now() - live.startedAt;
      parts.push(...toCells([{ t: `⏱ ${fmtDuration(elapsed)}`, s: st(theme, "faint") }]));
      if (live.content) {
        const chars = live.content.length + live.reasoning.length;
        parts.push(...toCells([{ t: " · ", s: st(theme, "faint") }]));
        parts.push(...toCells([{ t: `${fmtTokens(Math.round(chars / 4))} tok`, s: st(theme, "faint") }]));
      }
      return parts;
    }
    if (!tel) return parts;

    if (tel.ttftMs !== undefined) parts.push(...toCells([{ t: `⚡ ${fmtDuration(tel.ttftMs)}`, s: st(theme, "muted") }]));
    if (tel.totalMs !== undefined) {
      if (parts.length) sep();
      parts.push(...toCells([{ t: `⏱ ${fmtDuration(tel.totalMs)}`, s: st(theme, "muted") }]));
    }
    if (tel.tokensPerSec) {
      sep();
      parts.push(...toCells([{ t: `${tel.tokensPerSec.toFixed(1)} tok/s`, s: st(theme, "muted") }]));
    }
    if (tel.promptTokens || tel.completionTokens) {
      sep();
      parts.push(...toCells([{ t: `${fmtTokens(tel.promptTokens ?? 0)}→${fmtTokens(tel.completionTokens ?? 0)}`, s: st(theme, "faint") }]));
    }
    if (tel.attempts !== undefined) {
      sep();
      parts.push(...toCells([{ t: `${tel.attempts} attempt${tel.attempts === 1 ? "" : "s"}`, s: tel.attempts > 1 ? st(theme, "warn") : st(theme, "faint") }]));
    }
    if (tel.degraded) {
      sep();
      parts.push(...toCells([{ t: "degraded", s: st(theme, "warn", { bold: true }) }]));
    }
    if (tel.traceId) {
      sep();
      parts.push(...toCells([{ t: `trace ${tel.traceId.slice(0, 10)}`, s: st(theme, "faint") }]));
    }
    if (msg.memoryRefs?.length) {
      sep();
      parts.push(...toCells([{ t: `✦ ${msg.memoryRefs.length} memories`, s: st(theme, "memory") }]));
    }
    return parts;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text;
}

export function prettyJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "{}";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}
