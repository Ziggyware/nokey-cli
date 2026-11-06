/**
 * Terminal cell primitives.
 *
 * Everything the UI draws is described as a list of {@link Cell}s instead of
 * pre-baked ANSI strings. Layout, wrapping and truncation then operate on real
 * display widths, and escapes are emitted exactly once at paint time. That
 * keeps wide (CJK/emoji) text aligned and makes rendering testable without a
 * terminal.
 */

/** A colour is a `#rrggbb` hex string, `ansi:<0-255>`, or `default`. */
export type Color = string;

export interface Style {
  fg?: Color;
  bg?: Color;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  reverse?: boolean;
}

export interface Cell {
  /** Grapheme cluster. */
  t: string;
  /** Display width in columns (0, 1 or 2). */
  w: number;
  /** Style, or null for the terminal default. */
  s: Style | null;
}

export interface Segment {
  t: string;
  s?: Style | null;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Wide/ambiguous ranges that occupy two columns in a terminal. */
const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cd5],
  [0x1b000, 0x1b2fb],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f2ff],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

function isWide(cp: number): boolean {
  let lo = 0;
  let hi = WIDE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = WIDE[mid]!;
    if (cp < range[0]) hi = mid - 1;
    else if (cp > range[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\u200b\u200c\u200d\ufe0e\ufe0f]$/u;

/** Display width of a single grapheme cluster. */
export function graphemeWidth(g: string): number {
  if (g === "") return 0;
  const first = g.codePointAt(0);
  if (first === undefined) return 0;
  if (first === 0x09) return 4;
  // Control characters and combining marks take no room of their own.
  if (first < 0x20 || (first >= 0x7f && first < 0xa0)) return 0;
  if (ZERO_WIDTH.test(g)) return 0;
  // Emoji presentation selectors and ZWJ sequences render double width.
  if (g.length > 1 && (g.includes("\u200d") || g.includes("\ufe0f"))) {
    return isWide(first) || first >= 0x1f000 ? 2 : 2;
  }
  if (g.length === 1 && ZERO_WIDTH.test(g)) return 0;
  return isWide(first) ? 2 : 1;
}

/** Display width of a plain string (assumes no ANSI escapes). */
export function strWidth(s: string): number {
  let w = 0;
  for (const { segment } of segmenter.segment(s)) w += graphemeWidth(segment);
  return w;
}

/** Split a string into grapheme clusters. */
export function graphemes(s: string): string[] {
  const out: string[] = [];
  for (const { segment } of segmenter.segment(s)) out.push(segment);
  return out;
}

/** Turn styled segments into cells. Newlines are not allowed here. */
export function toCells(segments: Segment[]): Cell[] {
  const cells: Cell[] = [];
  for (const seg of segments) {
    if (seg.t === "") continue;
    for (const g of graphemes(seg.t)) {
      const w = graphemeWidth(g);
      if (w === 0) {
        // Attach zero-width clusters to the previous cell so it stays intact.
        const prev = cells[cells.length - 1];
        if (prev) {
          prev.t += g;
          continue;
        }
      }
      cells.push({ t: g, w, s: seg.s ?? null });
    }
  }
  return cells;
}

/** Convenience: plain text (optionally styled) to cells. */
export function cells(text: string, style: Style | null = null): Cell[] {
  return toCells([{ t: text, s: style }]);
}

export function cellsWidth(line: Cell[]): number {
  let w = 0;
  for (const c of line) w += c.w;
  return w;
}

export function cellsText(line: Cell[]): string {
  let out = "";
  for (const c of line) out += c.t;
  return out;
}

export function concatCells(...parts: Cell[][]): Cell[] {
  return parts.flat();
}

export function blankCells(width: number, style: Style | null = null): Cell[] {
  const out: Cell[] = [];
  for (let i = 0; i < width; i++) out.push({ t: " ", w: 1, s: style });
  return out;
}

/** Pad (or truncate) to exactly `width` columns. */
export function padCells(line: Cell[], width: number, style: Style | null = null): Cell[] {
  const w = cellsWidth(line);
  if (w === width) return line;
  if (w > width) return sliceCells(line, 0, width);
  return [...line, ...blankCells(width - w, style)];
}

export function sliceCells(line: Cell[], start: number, end: number): Cell[] {
  const out: Cell[] = [];
  let pos = 0;
  for (const c of line) {
    const next = pos + c.w;
    // A double-width cluster only survives if it fits entirely inside the range.
    if (pos >= start && next <= end) out.push(c);
    pos = next;
    if (pos >= end) break;
  }
  return out;
}

/** Restyle every cell, merging onto (or replacing) the existing style. */
export function restyle(line: Cell[], style: Style | null, mode: "merge" | "replace" = "merge"): Cell[] {
  if (mode === "replace") return line.map((c) => ({ ...c, s: style }));
  return line.map((c) => ({ ...c, s: { ...(c.s ?? {}), ...(style ?? {}) } }));
}

export interface WrapOptions {
  /** Columns to indent continuation lines by. */
  hang?: number;
  /** Style for the hanging indent. */
  hangStyle?: Style | null;
  /** Never break inside a word, overflow instead (used for tables). */
  noHardBreak?: boolean;
}

/**
 * Greedy word wrap on cells. Breaks at spaces when possible, otherwise hard
 * breaks — but never in the middle of a wide cluster.
 */
export function wrapCells(line: Cell[], width: number, opts: WrapOptions = {}): Cell[][] {
  if (width <= 0) return [[]];
  const hang = opts.hang ?? 0;
  const out: Cell[][] = [];
  let current: Cell[] = [];
  let currentWidth = 0;
  let lastBreak = -1; // index in `current` just after the break opportunity
  let lineNo = 0;

  const avail = () => (lineNo === 0 ? width : Math.max(1, width - hang));
  const flush = () => {
    out.push(current);
    current = [];
    currentWidth = 0;
    lastBreak = -1;
    lineNo++;
  };

  for (let i = 0; i < line.length; i++) {
    const cell = line[i]!;
    if (cell.t === "\n") {
      flush();
      continue;
    }
    const limit = avail();
    if (currentWidth + cell.w > limit && currentWidth > 0) {
      if (lastBreak > 0 && !opts.noHardBreak) {
        const head = current.slice(0, lastBreak);
        let tail = current.slice(lastBreak);
        while (tail.length && tail[0]!.t === " ") tail = tail.slice(1);
        out.push(head);
        current = tail;
        currentWidth = cellsWidth(current);
        lastBreak = -1;
        lineNo++;
      } else {
        flush();
      }
    }
    current.push(cell);
    currentWidth += cell.w;
    if (cell.t === " " || cell.t === "-" || cell.t === "/" || cell.t === "," || cell.t === "\t") {
      lastBreak = current.length;
    }
  }
  out.push(current);

  // Apply hanging indent to continuation lines.
  if (hang > 0 && out.length > 1) {
    for (let i = 1; i < out.length; i++) {
      const indent = blankCells(hang, opts.hangStyle ?? null);
      const merged = cellsWidth(out[i]!) + hang > width ? sliceCells(out[i]!, 0, width - hang) : out[i]!;
      out[i] = [...indent, ...merged];
    }
  }
  return out;
}

/** Split cells into lines on explicit newlines only. */
export function splitCells(line: Cell[]): Cell[][] {
  const out: Cell[][] = [];
  let cur: Cell[] = [];
  for (const c of line) {
    if (c.t === "\n") {
      out.push(cur);
      cur = [];
    } else cur.push(c);
  }
  out.push(cur);
  return out;
}

/** Pad every line to the same width — handy for side-by-side composition. */
export function equalize(lines: Cell[][], width?: number): Cell[][] {
  const w = width ?? Math.max(0, ...lines.map((l) => cellsWidth(l)));
  return lines.map((l) => padCells(l, w));
}
