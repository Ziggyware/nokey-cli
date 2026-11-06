/** Header, footer and chips: the always-on colour coding of app state. */
import type { Cell, Style } from "../util/cells.ts";
import { blankCells, cellsWidth, padCells, sliceCells, toCells, wrapCells } from "../util/cells.ts";
import { st } from "./theme.ts";
import type { Theme } from "./theme.ts";
import type { Config } from "../store/config.ts";
import type { ContextStats } from "../core/context.ts";
import { fmtDuration } from "../util/time.ts";
import { fmtTokens } from "../util/tokens.ts";

export interface HeaderState {
  title: string;
  model: string;
  context?: ContextStats;
  memoryCount: number;
  sessionId: string;
  online: boolean | null;
  busy: boolean;
  theme: Theme;
  config: Config;
  width: number;
  live: boolean;
}

/** One-line header: brand, session, model lane, context meter, memory, health. */
export function renderHeader(state: HeaderState): Cell[] {
  const { theme, width } = state;
  const out: Cell[] = [];
  const push = (text: string, style: Style | null) => out.push(...toCells([{ t: text, s: style }]));

  push("◈ ", st(theme, "accent", { bold: true }));
  push("nokey", st(theme, "accent", { bold: true }));
  push(" ", null);
  push(truncateTitle(state.title, Math.max(12, Math.min(46, width - 52))), st(theme, "fg", { bold: true }));

  const dot = state.busy ? "●" : state.online === false ? "●" : state.online === null ? "○" : "●";
  push("  ", null);
  push(dot, state.busy ? st(theme, "spinner") : state.online === false ? st(theme, "error") : st(theme, "ok"));

  push(" ", null);
  out.push(...chip(`⛁ ${state.model}`, theme, "accent2"));

  push(" ", null);
  out.push(...chip(`✦ ${state.memoryCount}`, theme, "memory"));

  if (state.config.ui.showTokenBar && state.context) {
    push("  ", null);
    out.push(...contextMeter(state.context, theme, Math.min(20, Math.max(8, Math.floor(width / 6)))));
  }

  push("  ", null);
  push(`⌗ ${state.sessionId.slice(2, 8)}`, st(theme, "faint"));

  const used = cellsWidth(out);
  if (used < width) out.push(...blankCells(width - used));
  return sliceCells(out, 0, width);
}

export function contextMeter(stats: ContextStats, theme: Theme, width: number): Cell[] {
  const ratio = Math.min(1, stats.totalTokens / Math.max(1, stats.windowTokens));
  const filled = Math.round(ratio * width);
  const color: Style =
    ratio > 0.9 ? st(theme, "error") : ratio > stats.budgetTokens / Math.max(1, stats.windowTokens) ? st(theme, "warn") : st(theme, "ok");
  const cells: Cell[] = [];
  cells.push(...toCells([{ t: "▕", s: st(theme, "faint") }]));
  const fg = color.fg;
  const dimColor = theme.palette.border;
  if (filled > 0) cells.push(...toCells([{ t: "█".repeat(filled), s: { fg } }]));
  if (width - filled > 0) cells.push(...toCells([{ t: "░".repeat(width - filled), s: { fg: dimColor } }]));
  cells.push(...toCells([{ t: "▏", s: st(theme, "faint") }]));
  cells.push(...toCells([{ t: ` ${Math.round(ratio * 100)}%`, s: st(theme, ratio > 0.9 ? "error" : "muted") }]));
  return cells;
}

export interface FooterState {
  theme: Theme;
  width: number;
  busy: boolean;
  spinner: string;
  status: string;
  notices: string[];
  hints: string[];
  tokens?: number;
  context?: ContextStats;
  keysConfigured: boolean;
  degraded?: boolean;
  streaming: boolean;
  queue: number;
}

/** Status bar: spinner/status on the left, hints and counters on the right. */
export function renderFooter(state: FooterState): Cell[] {
  const { theme, width } = state;
  const left: Cell[] = [];
  const push = (text: string, style: Style | null) => left.push(...toCells([{ t: text, s: style }]));

  if (state.busy) {
    push(` ${state.spinner} `, st(theme, "spinner", { bold: true }));
  } else {
    push(" ❯ ", st(theme, "accent", { bold: true }));
  }
  const status = state.notices.length ? state.notices[state.notices.length - 1]! : state.status;
  push(status, state.notices.length ? st(theme, "accent3") : st(theme, "statusFg"));

  const right: Cell[] = [];
  const rpush = (text: string, style: Style | null) => right.push(...toCells([{ t: text, s: style }]));
  if (state.degraded) {
    rpush("degraded ", st(theme, "warn", { bold: true }));
    rpush("· ", st(theme, "faint"));
  }
  if (state.context) {
    rpush(`${fmtTokens(state.context.totalTokens)}/${fmtTokens(state.context.windowTokens)} `, st(theme, "muted"));
    rpush("· ", st(theme, "faint"));
  }
  if (!state.keysConfigured) {
    rpush("no key ", st(theme, "error", { bold: true }));
    rpush("· ", st(theme, "faint"));
  }
  const hint = state.busy ? "esc stop" : state.hints[0] ?? "? help";
  rpush(hint, st(theme, "faint"));

  const pad = Math.max(0, width - cellsWidth(left) - cellsWidth(right));
  const line = [...left, ...blankCells(pad), ...right];
  return sliceCells(line, 0, width);
}

/** The input box: rule, prompt, wrapped text, hint row. */
export interface InputState {
  theme: Theme;
  width: number;
  lines: string[];
  row: number;
  col: number;
  scroll: number;
  maxHeight: number;
  suggestions: Array<{ label: string; hint: string }>;
  suggestionIndex: number;
  placeholder: string;
  attachment?: string;
}

export function renderInput(state: InputState): { cells: Cell[][]; cursor: { row: number; col: number } | null } {
  const { theme, width } = state;
  const rows: Cell[][] = [];
  const rule = toCells([{ t: "─".repeat(width), s: st(theme, "border") }]);
  rows.push(rule);

  const visible = state.lines.slice(state.scroll, state.scroll + state.maxHeight);
  const isMulti = state.lines.length > 1;
  for (let i = 0; i < visible.length; i++) {
    const isFirst = i === 0;
    const prompt = isFirst ? " ❯ " : isMulti ? "   " : "   ";
    const prefix = toCells([{ t: prompt, s: isFirst ? st(theme, "accent", { bold: true }) : null }]);
    const text = visible[i] ?? "";
    const style = state.lines.length === 1 && !text ? st(theme, "placeholder", { italic: true }) : st(theme, "fg");
    const body = toCells([{ t: text || (state.lines.length === 1 ? state.placeholder : ""), s: style }]);
    rows.push(sliceCells([...prefix, ...body], 0, width));
  }

  // Suggestion popup (slash completion), rendered above the hint row.
  if (state.suggestions.length) {
    const max = Math.min(6, state.suggestions.length);
    for (let i = 0; i < max; i++) {
      const s = state.suggestions[i]!;
      const active = i === state.suggestionIndex;
      const style: Style = active ? { fg: theme.palette.bg, bg: theme.palette.accent, bold: true } : st(theme, "muted");
      const label = toCells([{ t: ` ${s.label.padEnd(16)} `, s: style }]);
      const hint = toCells([{ t: ` ${s.hint}`, s: active ? st(theme, "accent") : st(theme, "faint") }]);
      rows.push(sliceCells([...toCells([{ t: "   ", s: null }]), ...label, ...hint], 0, width));
    }
    return { cells: rows, cursor: null };
  }

  const hintRow: Cell[] = [];
  const hintStyle = st(theme, "faint");
  const isFirst = state.lines.length === 1;
  hintRow.push(...toCells([{ t: "   ", s: null }]));
  const hints = isFirst
    ? [["enter", "send"], ["alt+enter", "newline"], ["/", "commands"], ["ctrl+k", "palette"]]
    : [["enter", "send"], ["alt+enter", "newline"], ["esc", "clear"], ["ctrl+k", "palette"]];
  for (const [key, label] of hints) {
    hintRow.push(...toCells([{ t: ` ${key} `, s: { fg: theme.palette.bg, bg: theme.palette.faint } }]));
    hintRow.push(...toCells([{ t: ` ${label}  `, s: hintStyle }]));
  }
  if (state.attachment) {
    hintRow.push(...toCells([{ t: ` ${state.attachment}`, s: st(theme, "accent3") }]));
  }
  rows.push(sliceCells(hintRow, 0, width));

  const cursorRow = 1 + (state.row - state.scroll);
  const cursor = { row: cursorRow, col: 3 + state.col };
  return { cells: rows, cursor };
}

function chip(text: string, theme: Theme, token: "accent" | "accent2" | "accent3" | "memory" | "ok" | "muted"): Cell[] {
  const color = theme.palette[token];
  return toCells([{ t: ` ${text} `, s: { fg: color, bg: theme.palette.chipBg, bold: true } }]);
}

function truncateTitle(title: string, max: number): string {
  if (title.length <= max) return title;
  return `${title.slice(0, Math.max(4, max - 1))}…`;
}

/** Wrap a plain sentence into the available width (for notices). */
export function notice(text: string, theme: Theme, width: number, tone: "info" | "warn" | "error" | "ok" = "info"): Cell[][] {
  return wrapCells(toCells([{ t: text, s: st(theme, tone) }]), width);
}

/** Right-aligned meta line used above overlays. */
export function metaLine(left: string, right: string, theme: Theme, width: number): Cell[] {
  const l = toCells([{ t: left, s: st(theme, "muted") }]);
  const r = toCells([{ t: right, s: st(theme, "faint") }]);
  const pad = Math.max(1, width - cellsWidth(l) - cellsWidth(r));
  return padCells([...l, ...blankCells(pad), ...r], width);
}

export { fmtDuration };
