/**
 * Overlays.
 *
 * One generic framed list drives the palette, session switcher, memory manager,
 * model picker, theme picker, history and search — same keys, same look, so
 * learning one teaches them all. Help and confirm are simple framed panes.
 */
import type { Cell, Segment, Style } from "../util/cells.ts";
import { blankCells, cellsWidth, padCells, sliceCells, toCells, wrapCells } from "../util/cells.ts";
import { st } from "./theme.ts";
import type { Theme, Token } from "./theme.ts";
import { fuzzyFilter } from "../util/fuzzy.ts";

export type OverlayKind = "list" | "help" | "confirm" | "stats" | "peek";

export interface OverlayItem {
  id: string;
  label: string;
  hint?: string;
  meta?: string;
  badge?: string;
  tone?: Token;
  /** Extra search text (description, body). */
  detail?: string;
  /** Disabled items render dim and cannot be activated. */
  disabled?: boolean;
}

export interface OverlayState {
  kind: OverlayKind;
  title: string;
  subtitle?: string;
  /** Live filter text for list overlays (typed by the user). */
  query?: string;
  items?: OverlayItem[];
  selected?: number;
  /** Index into the filtered items. */
  cursor?: number;
  scroll?: number;
  footer?: string;
  /** Free-form lines for help/stats/peek. */
  body?: string;
  /** Confirm prompt. */
  prompt?: string;
  onAcceptLabel?: string;
  tone?: Token;
  /** Fixed width hint. */
  width?: number;
  height?: number;
}

export interface OverlayContext {
  theme: Theme;
  cols: number;
  rows: number;
}

export function filteredItems(state: OverlayState): OverlayItem[] {
  const items = state.items ?? [];
  const q = state.query ?? "";
  if (!state.query) return items;
  return fuzzyFilter(items, q, (i) => i.label, (i) => `${i.hint ?? ""} ${i.detail ?? ""}`).map((s) => s.item);
}

export function moveOverlayCursor(state: OverlayState, delta: number): void {
  const items = filteredItems(state);
  if (!items.length) return;
  const next = Math.max(0, Math.min(items.length - 1, (state.cursor ?? 0) + delta));
  state.cursor = next;
}

export function renderOverlay(state: OverlayState, ctx: OverlayContext): Cell[][] {
  const { theme } = ctx;
  const boxWidth = Math.max(30, Math.min(ctx.cols - 4, state.width ?? (state.kind === "help" ? 78 : 88)));
  const maxHeight = Math.max(6, ctx.rows - 4);
  if (state.kind === "help" || state.kind === "stats" || state.kind === "peek") {
    return renderPane(state, ctx, boxWidth, maxHeight);
  }
  if (state.kind === "confirm") {
    return renderConfirm(state, ctx, boxWidth);
  }
  return renderList(state, ctx, boxWidth, maxHeight);
}

function frame(width: number, rows: Cell[][], theme: Theme, title: string, subtitle: string | undefined, footer: string | undefined): Cell[][] {
  const out: Cell[][] = [];
  const inner = width - 2;
  const border = st(theme, "borderActive");

  const titleSegments: Segment[] = [
    { t: "╭─", s: border },
    { t: ` ${title} `, s: st(theme, "accent", { bold: true }) },
  ];
  if (subtitle) titleSegments.push({ t: `${subtitle} `, s: st(theme, "faint") }, { t: "─", s: border });
  const titleCells = toCells(titleSegments);
  const fill = Math.max(0, width - cellsWidth(titleCells) - 1);
  out.push(padCells([...titleCells, ...toCells([{ t: "─".repeat(fill), s: border }, { t: "╮", s: border }])], width));

  for (const row of rows) {
    out.push([...toCells([{ t: "│", s: border }]), ...padCells(row, inner), ...toCells([{ t: "│", s: border }])]);
  }

  if (footer) {
    const label = toCells([{ t: ` ${footer} `, s: st(theme, "faint") }]);
    const rest = Math.max(0, inner - cellsWidth(label));
    out.push(
      padCells(
        [
          ...toCells([{ t: "├", s: border }]),
          ...label,
          ...toCells([{ t: "─".repeat(rest), s: border }]),
          ...toCells([{ t: "┤", s: border }]),
        ],
        width,
      ),
    );
  }
  out.push(
    padCells(
      [...toCells([{ t: "╰", s: border }]), ...toCells([{ t: "─".repeat(inner), s: border }]), ...toCells([{ t: "╯", s: border }])],
      width,
    ),
  );
  return out;
}

function renderList(state: OverlayState, ctx: OverlayContext, width: number, maxHeight: number): Cell[][] {
  const { theme } = ctx;
  const inner = width - 2;
  const items = filteredItems(state);
  const rows: Cell[][] = [];

  if (state.query) {
    rows.push(
      padCells(
        [
          ...toCells([{ t: " ❯ ", s: st(theme, "accent", { bold: true }) }]),
          ...toCells([{ t: state.query, s: st(theme, "fg") }]),
          ...toCells([{ t: "▊", s: st(theme, "cursor") }]),
        ],
        inner,
      ),
    );
  }

  const visibleRows = Math.max(3, maxHeight - 5 - (state.query ? 1 : 0));
  if (state.cursor !== undefined && state.cursor < (state.scroll ?? 0)) state.scroll = state.cursor;
  if (state.cursor !== undefined && state.cursor >= (state.scroll ?? 0) + visibleRows) state.scroll = state.cursor - visibleRows + 1;
  const scroll = Math.max(0, Math.min(state.scroll ?? 0, Math.max(0, items.length - visibleRows)));

  if (!items.length) {
    rows.push(padCells(toCells([{ t: "  (nothing matches)", s: st(theme, "faint", { italic: true }) }]), inner));
  }

  for (let i = scroll; i < Math.min(items.length, scroll + visibleRows); i++) {
    const item = items[i]!;
    const active = i === state.cursor;
    const tone = item.tone ?? "fg";
    const base: Style = item.disabled ? st(theme, "faint") : active ? { fg: theme.palette.bg, bg: theme.palette.accent, bold: true } : st(theme, tone);
    const badgeStyle: Style = active ? { fg: theme.palette.bg, bg: theme.palette.accent } : st(theme, item.tone ?? "accent2");
    const metaStyle: Style = active ? { fg: theme.palette.bg, bg: theme.palette.accent, dim: true } : st(theme, "faint");

    const badge = item.badge ? toCells([{ t: ` ${item.badge} `, s: badgeStyle }]) : blankCells(0);
    const label = toCells([{ t: `${item.label}`, s: base }]);
    const hint = item.hint ? toCells([{ t: `  ${item.hint}`, s: active ? { fg: theme.palette.bg, bg: theme.palette.accent } : st(theme, "muted") }]) : [];
    // Leading + trailing space keep the keybinding from touching the hint/border.
    const meta = item.meta ? toCells([{ t: ` ${item.meta} `, s: metaStyle }]) : [];

    // Budget the row: badge + label + hint + meta must never collide.
    const badgeW = cellsWidth(item.badge ? badge : []);
    const metaW = cellsWidth(meta);
    const content = Math.max(6, inner - 2 - badgeW - metaW);
    const labelNatural = cellsWidth(label);
    const labelBudget = Math.min(labelNatural, Math.max(4, Math.floor(content * 0.62)));
    const labelCells = labelNatural > labelBudget ? sliceCells(label, 0, Math.max(0, labelBudget - 1)) : label;
    if (labelNatural > labelBudget) labelCells.push(...toCells([{ t: "…", s: base }]));
    const hintBudget = Math.max(0, content - cellsWidth(labelCells) - 2);
    const hintCells = cellsWidth(hint) > hintBudget ? sliceCells(hint, 0, Math.max(0, hintBudget - 1)) : hint;
    const gap = Math.max(0, content - cellsWidth(labelCells) - cellsWidth(hintCells));
    const activeBg = active ? { bg: theme.palette.accent } : null;
    const row = padCells(
      [...toCells([{ t: " ", s: activeBg }]), ...badge, ...labelCells, ...blankCells(gap, activeBg), ...hintCells, ...meta],
      inner,
      activeBg,
    );
    rows.push(row);
  }

  if (items.length > visibleRows) {
    const info = toCells([{ t: ` ${scroll + 1}-${Math.min(items.length, scroll + visibleRows)} of ${items.length}`, s: st(theme, "faint") }]);
    rows.push(padCells(info, inner));
  }

  const footer = state.footer ?? "↑↓ move · ⏎ select · esc close · type to filter";
  return frame(width, rows, theme, state.title, state.subtitle, footer);
}

function renderPane(state: OverlayState, ctx: OverlayContext, width: number, maxHeight: number): Cell[][] {
  const { theme } = ctx;
  const inner = width - 2;
  const body = (state.body ?? "").replace(/\r/g, "");
  const rows: Cell[][] = [];
  const lines: Cell[][] = [];
  for (const raw of body.split("\n")) {
    if (!raw) {
      lines.push([]);
      continue;
    }
    // Simple markup: "## " section headings, "key — description" alignment left.
    if (raw.startsWith("## ")) {
      lines.push(toCells([{ t: raw.slice(3), s: st(theme, "h2", { bold: true }) }]));
    } else if (raw.startsWith("- ")) {
      const wrapped = wrapCells(toCells([{ t: raw.slice(2), s: st(theme, "fg") }]), inner - 4);
      for (let i = 0; i < wrapped.length; i++) {
        lines.push([...toCells([{ t: i === 0 ? "  • " : "    ", s: st(theme, "listMark") }]), ...wrapped[i]!]);
      }
    } else if (raw.startsWith(">> ")) {
      lines.push(toCells([{ t: raw.slice(3), s: st(theme, "accent3", { italic: true }) }]));
    } else {
      const wrapped = wrapCells(toCells([{ t: raw, s: st(theme, "muted") }]), inner - 2);
      for (const w of wrapped) lines.push([...toCells([{ t: "  ", s: null }]), ...w]);
    }
  }
  const viewport = Math.max(4, maxHeight - 4);
  const scroll = Math.max(0, Math.min(state.scroll ?? 0, Math.max(0, lines.length - viewport)));
  for (let i = scroll; i < Math.min(lines.length, scroll + viewport); i++) rows.push(padCells(lines[i]!, inner));
  const more = lines.length > viewport ? ` · ${scroll + 1}-${Math.min(lines.length, scroll + viewport)}/${lines.length}` : "";
  return frame(width, rows, theme, state.title, state.subtitle, (state.footer ?? "↑↓ scroll · esc close") + more);
}

function renderConfirm(state: OverlayState, ctx: OverlayContext, width: number): Cell[][] {
  const { theme } = ctx;
  const inner = width - 2;
  const rows: Cell[][] = [];
  const wrapped = wrapCells(toCells([{ t: state.prompt ?? "Are you sure?", s: st(theme, state.tone ?? "fg") }]), inner - 4);
  for (const line of wrapped) rows.push(padCells([...toCells([{ t: "  ", s: null }]), ...line], inner));
  rows.push([]);
  rows.push(
    padCells(
      [
        ...toCells([{ t: "  ", s: null }]),
        ...toCells([{ t: ` ${state.onAcceptLabel ?? "confirm"} `, s: { fg: theme.palette.bg, bg: theme.palette.error, bold: true } }]),
        ...toCells([{ t: "   esc ", s: st(theme, "faint") }]),
        ...toCells([{ t: "cancel", s: st(theme, "muted") }]),
      ],
      inner,
    ),
  );
  return frame(width, rows, theme, state.title, state.subtitle, state.footer ?? "⏎ confirm · esc cancel");
}

/** Overlay titles for each palette flavour. */
export const OVERLAY_TITLES: Record<string, string> = {
  palette: "Commands",
  sessions: "Sessions",
  memory: "Memory",
  models: "Model lane",
  themes: "Theme",
  history: "Prompt history",
  jump: "Jump to message",
  search: "Search this session",
};
