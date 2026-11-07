/**
 * Markdown → cells.
 *
 * Turns parsed blocks into styled terminal cells at a given width. The code
 * renderer draws a colour-coded gutter (border, line numbers, language badge)
 * and highlights through {@link highlight}; the table renderer fits any table
 * into the viewport.
 */
import {
  blankCells,
  cellsWidth,
  concatCells,
  padCells,
  sliceCells,
  toCells,
  wrapCells,
} from "../util/cells.ts";
import type { Cell, Style } from "../util/cells.ts";
import type { Token, Theme } from "../ui/theme.ts";
import { st } from "../ui/theme.ts";
import { highlight, languageLabel } from "./highlight.ts";
import type { TokenType } from "./highlight.ts";
import { parseInline, parseMarkdown } from "./markdown.ts";
import type { Block, ListItem, Span } from "./markdown.ts";

export interface MarkdownOptions {
  theme: Theme;
  width: number;
  /** Default text colour token for prose (roles override it). */
  tone?: Token;
  /** Show line numbers in code gutters. */
  lineNumbers?: boolean;
  /** Wrap long code lines instead of clipping them. */
  codeWrap?: boolean;
  /** Show the language badge above code blocks. */
  codeHeader?: boolean;
  /** Highlight a search term inside the rendered output. */
  highlightTerm?: string;
  /** Collapse code blocks longer than this many lines (0 disables). */
  maxCodeLines?: number;
  /** Prefix for each line, e.g. the role gutter. */
  prefix?: Cell[];
  /** Style applied to prefixes added during wrapping. */
  prefixStyle?: Style | null;
}

const TOKEN_TO_THEME: Record<TokenType, Token> = {
  plain: "fg",
  kw: "kw",
  str: "str",
  num: "num",
  comment: "comment",
  fn: "fn",
  type: "type",
  var: "var",
  op: "op",
  punct: "punct",
  regex: "regex",
  tag: "tag",
  attr: "attr",
  builtin: "builtin",
  meta: "meta",
  escape: "escape",
  const: "num",
  added: "added",
  removed: "removed",
  diffHunk: "diffHunk",
};

/** Render inline markdown (no block structure) to a single line of cells. */
export function renderInline(text: string, opts: MarkdownOptions, base?: Style | null): Cell[] {
  const theme = opts.theme;
  const tone = opts.tone ?? "fg";
  const out: Cell[] = [];
  const spans: Span[] = parseInline(text);
  for (const span of spans) {
    const style: Style = { ...(base ?? st(theme, tone)) };
    if (span.code) {
      style.bg = theme.palette.inlineBg;
      style.fg = theme.palette.str;
    }
    if (span.bold) style.bold = true;
    if (span.italic) style.italic = true;
    if (span.strike) style.strike = true;
    if (span.underline) style.underline = true;
    if (span.link) {
      style.fg = theme.palette.link;
      style.underline = true;
    }
    out.push(...toCells([{ t: span.text, s: style }]));
  }
  return applyHighlightMark(out, opts);
}

function applyHighlightMark(line: Cell[], opts: MarkdownOptions): Cell[] {
  const term = opts.highlightTerm?.trim();
  if (!term) return line;
  const needle = term.toLowerCase();
  const text = line.map((c) => c.t).join("").toLowerCase();
  if (!text.includes(needle)) return line;
  // Map character offsets back onto cells.
  const out: Cell[] = [];
  let pos = 0;
  const starts: number[] = [];
  for (const c of line) {
    starts.push(pos);
    pos += c.t.length;
  }
  let searchFrom = 0;
  let hit = text.indexOf(needle, searchFrom);
  const mark = new Set<number>();
  while (hit !== -1) {
    for (let i = 0; i < line.length; i++) {
      const start = starts[i]!;
      const end = start + line[i]!.t.length;
      if (end > hit && start < hit + needle.length) mark.add(i);
    }
    searchFrom = hit + needle.length;
    hit = text.indexOf(needle, searchFrom);
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (mark.has(i)) out.push({ ...c, s: { ...(c.s ?? {}), bg: opts.theme.palette.selectionBg, bold: true } });
    else out.push(c);
  }
  return out;
}

/** Render a full markdown document. */
export function renderMarkdown(text: string, opts: MarkdownOptions): Cell[][] {
  const blocks = parseMarkdown(text);
  const lines: Cell[][] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const rendered = renderBlock(block, opts);
    if (!rendered.length) continue;
    const prev = blocks[i - 1];
    if (lines.length && prev && prev.kind !== "blank" && block.kind !== "list") {
      // A single breathing row between distinct block types, except inside lists.
      lines.push([]);
    }
    lines.push(...rendered);
  }
  return withPrefix(lines, opts);
}

function withPrefix(lines: Cell[][], opts: MarkdownOptions): Cell[][] {
  if (!opts.prefix) return lines;
  return lines.map((l) => [...opts.prefix!, ...l]);
}

function renderBlock(block: Block, opts: MarkdownOptions): Cell[][] {
  switch (block.kind) {
    case "heading":
      return renderHeading(block.level, block.text, opts);
    case "paragraph":
      return wrapStyled(renderInline(block.text, opts), opts);
    case "code":
      return renderCode(block, opts);
    case "list":
      return renderList(block.items, opts);
    case "quote":
      return renderQuote(block.text, opts);
    case "table":
      return renderTable(block, opts);
    case "hr":
      return [toCells([{ t: "─".repeat(Math.max(4, opts.width)), s: st(opts.theme, "hr") }])];
    case "blank":
      return [];
  }
}

function renderHeading(level: number, text: string, opts: MarkdownOptions): Cell[][] {
  const theme = opts.theme;
  const token: Token = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
  const base: Style = {
    ...st(theme, token),
    bold: true,
    underline: level === 1,
  };
  const inner = renderInline(text, opts, base);
  const lines = wrapCells(inner, opts.width);
  if (level === 1) {
    // Rule under h1 for visual hierarchy.
    const rule = toCells([{ t: "─".repeat(Math.min(opts.width, Math.max(8, cellsWidth(inner)))), s: st(theme, "hr") }]);
    return [...lines, rule];
  }
  return lines;
}

function wrapStyled(line: Cell[], opts: MarkdownOptions): Cell[][] {
  return wrapCells(line, opts.width).map((l) => (l.length === 0 ? [] : l));
}

function roleStyle(opts: MarkdownOptions): Style {
  return st(opts.theme, opts.tone ?? "fg");
}

function renderList(items: ListItem[], opts: MarkdownOptions): Cell[][] {
  const theme = opts.theme;
  const out: Cell[][] = [];
  for (const item of items) {
    const indent = "  ".repeat(item.level);
    const bulletColor = item.level === 0 ? theme.palette.listMark : theme.palette.muted;
    let marker: string;
    let markerStyle: Style;
    if (item.checked === true) {
      marker = "✔";
      markerStyle = st(theme, "ok", { bold: true });
    } else if (item.checked === false) {
      marker = "☐";
      markerStyle = st(theme, "muted");
    } else {
      marker = item.ordered ? `${item.marker}` : "•";
      markerStyle = { fg: bulletColor, bold: item.ordered };
    }
    const gutterText = `${indent}${marker} `;
    const gutter = toCells([{ t: gutterText, s: markerStyle }]);
    const gutterWidth = cellsWidth(gutter);
    const body = renderInline(item.text, opts, item.checked === true ? { ...roleStyle(opts), dim: true, strike: false } : roleStyle(opts));
    const wrapped = wrapCells(body, Math.max(8, opts.width - gutterWidth));
    for (let i = 0; i < wrapped.length; i++) {
      const prefix = i === 0 ? gutter : blankCells(gutterWidth, null);
      out.push([...prefix, ...wrapped[i]!]);
    }
  }
  return out;
}

function renderQuote(text: string, opts: MarkdownOptions): Cell[][] {
  const theme = opts.theme;
  const bar = toCells([{ t: "▏ ", s: st(theme, "quote") }]);
  const inner = renderInline(text.replace(/\n/g, " "), opts, {
    ...st(theme, "quote"),
    italic: true,
  });
  const wrapped = wrapCells(inner, Math.max(8, opts.width - 2));
  return wrapped.map((l) => [...bar, ...l]);
}

function renderTable(block: Extract<Block, { kind: "table" }>, opts: MarkdownOptions): Cell[][] {
  const theme = opts.theme;
  const cols = Math.max(block.header.length, ...block.rows.map((r) => r.length));
  const header = Array.from({ length: cols }, (_, i) => block.header[i] ?? "");
  const rows = block.rows.map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? ""));
  const align = Array.from({ length: cols }, (_, i) => block.align[i] ?? "left");

  // Each column costs `│` + space + content + space; plus a closing bar.
  const chrome = cols * 3 + 1;
  const available = Math.max(6, opts.width - chrome);
  const natural = Array.from({ length: cols }, (_, i) =>
    Math.max(cellsWidth(renderInline(header[i]!, opts)), ...rows.map((r) => cellsWidth(renderInline(r[i]!, opts))), 3),
  );
  const widths = fitColumns(natural, available);

  const bar = (ch: string) => toCells([{ t: ch, s: st(theme, "tableBorder") }]);
  const out: Cell[][] = [];

  const border = (left: string, mid: string, right: string) => {
    const parts: Cell[] = [];
    parts.push(...bar(left));
    widths.forEach((w, i) => {
      parts.push(...bar("─".repeat(w + 2)));
      parts.push(...bar(i === widths.length - 1 ? right : mid));
    });
    return parts;
  };

  out.push(border("┌", "┬", "┐"));
  out.push(
    composeRow(
      header.map((h, i) => renderInline(h, opts, { ...st(theme, "tableHeader"), bold: true })),
      widths,
      align,
      theme,
    ),
  );
  out.push(border("├", "┼", "┤"));
  for (const row of rows) {
    out.push(composeRow(row.map((c) => renderInline(c, opts)), widths, align, theme));
  }
  out.push(border("└", "┴", "┘"));
  return out;
}

function composeRow(content: Cell[][], widths: number[], align: string[], theme: Theme): Cell[] {
  const out: Cell[] = [];
  out.push(...toCells([{ t: "│", s: st(theme, "tableBorder") }]));
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i]!;
    let cell = content[i] ?? [];
    if (cellsWidth(cell) > w) cell = sliceCells(cell, 0, Math.max(0, w - 1)).concat(toCells([{ t: "…", s: st(theme, "muted") }]));
    const pad = w - cellsWidth(cell);
    const leftPad = align[i] === "right" ? pad : align[i] === "center" ? Math.floor(pad / 2) : 0;
    out.push(...blankCells(1, null), ...blankCells(leftPad, null), ...cell, ...blankCells(pad - leftPad, null), ...blankCells(1, null));
    out.push(...toCells([{ t: "│", s: st(theme, "tableBorder") }]));
  }
  return out;
}

function fitColumns(natural: number[], available: number): number[] {
  const widths = natural.map((w) => Math.max(3, w));
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > available) {
    let widest = 0;
    for (let i = 1; i < widths.length; i++) if (widths[i]! > widths[widest]!) widest = i;
    if (widths[widest]! <= 4) break;
    widths[widest] = widths[widest]! - 1;
    total--;
  }
  return widths;
}

function renderCode(block: Extract<Block, { kind: "code" }>, opts: MarkdownOptions): Cell[][] {
  const theme = opts.theme;
  const out: Cell[][] = [];
  const langLabel = languageLabel(block.lang);
  const metaName = /(?:title|file|name)="?([^"\s]+)"?/.exec(block.meta)?.[1] ?? "";
  const maxLines = opts.maxCodeLines && opts.maxCodeLines > 0 ? opts.maxCodeLines : Infinity;

  let codeLines = block.code.length ? block.code.split("\n") : [""];
  let hidden = 0;
  if (codeLines.length > maxLines) {
    hidden = codeLines.length - maxLines;
    codeLines = codeLines.slice(0, maxLines);
  }

  // Gutter: bar + line number + separator.
  const numberWidth = String(Math.max(codeLines.length, 1)).length;
  const gutterWidth = 2 /* bar+space */ + (opts.lineNumbers ? numberWidth + 1 : 0) + 2 /* │ + space */;
  const codeWidth = Math.max(8, opts.width - gutterWidth);

  if (opts.codeHeader !== false && (langLabel || metaName)) {
    const parts: Cell[] = [];
    parts.push(...toCells([{ t: "▎", s: st(theme, "codeBorder", { bold: true }) }]));
    parts.push(...toCells([{ t: " ", s: null }]));
    if (langLabel) parts.push(...toCells([{ t: langLabel.toLowerCase(), s: st(theme, "codeLang", { bold: true }) }]));
    if (metaName) {
      parts.push(...toCells([{ t: " · ", s: st(theme, "faint") }]));
      parts.push(...toCells([{ t: metaName, s: st(theme, "muted") }]));
    }
    if (!block.closed) {
      parts.push(...toCells([{ t: "  …streaming", s: st(theme, "faint", { italic: true }) }]));
    }
    out.push(sliceCells(parts, 0, opts.width));
  }

  const tokens = highlight(codeLines.join("\n"), block.lang);
  for (let i = 0; i < codeLines.length; i++) {
    const lineTokens = tokens[i] ?? [];
    const lineCells: Cell[] = [];
    for (const tok of lineTokens) {
      const style: Style = { ...st(theme, TOKEN_TO_THEME[tok.k] ?? "fg") };
      if (tok.k === "comment") style.italic = true;
      if (tok.k === "added" || tok.k === "removed") {
        style.bg = theme.palette[tok.k === "added" ? "addedBg" : "removedBg"];
      }
      lineCells.push(...toCells([{ t: tok.t, s: style }]));
    }
    const prefix: Cell[] = [
      ...toCells([{ t: "▎", s: st(theme, "codeBorder") }]),
      ...toCells([{ t: " ", s: null }]),
    ];
    if (opts.lineNumbers) {
      const num = String(i + 1).padStart(numberWidth, " ");
      prefix.push(...toCells([{ t: num, s: st(theme, "faint") }]), ...toCells([{ t: " ", s: null }]));
    }
    prefix.push(...toCells([{ t: "│", s: st(theme, "faint") }]), ...toCells([{ t: " ", s: null }]));

    const isDiffLine = lineTokens.some((t) => t.k === "added" || t.k === "removed" || t.k === "diffHunk");
    if (isDiffLine) {
      const kind = lineTokens.find((t) => t.k === "added" || t.k === "removed")?.k;
      const bg = kind ? theme.palette[kind === "added" ? "addedBg" : "removedBg"] : undefined;
      if (bg) {
        const fill = Math.max(0, codeWidth - cellsWidth(lineCells));
        out.push([...prefix, ...lineCells, ...blankCells(fill, { bg })].map((c) => ({ ...c, s: { ...(c.s ?? {}), bg } })));
        continue;
      }
    }

    if (opts.codeWrap === false) {
      out.push([...prefix, ...sliceCells(lineCells, 0, codeWidth)]);
      continue;
    }
    const wrapped = wrapCells(lineCells, codeWidth, { hang: 2, noHardBreak: false });
    for (let w = 0; w < wrapped.length; w++) {
      const p = w === 0 ? prefix : blankCells(gutterWidth, null);
      out.push([...p, ...wrapped[w]!]);
    }
  }

  // Closing bar keeps the block visually closed even mid-stream.
  out.push(...(hidden > 0 ? [[...toCells([{ t: "▎", s: st(theme, "codeBorder") }]), ...toCells([{ t: ` … ${hidden} more line${hidden === 1 ? "" : "s"} collapsed`, s: st(theme, "faint", { italic: true }) }])]] : []));
  return out;
}

/** Render plain wrapped text (no markdown) at a width. */
export function renderPlain(text: string, opts: MarkdownOptions, base?: Style): Cell[][] {
  const style = base ?? roleStyle(opts);
  const lines: Cell[][] = [];
  for (const raw of text.split("\n")) {
    const cells = toCells([{ t: raw, s: style }]);
    if (!cells.length) {
      lines.push([]);
      continue;
    }
    lines.push(...wrapCells(cells, opts.width));
  }
  return withPrefix(lines, opts);
}

/** Convenience for one-line labels that must never wrap. */
export function label(text: string, style: Style | null, width?: number): Cell[] {
  const c = toCells([{ t: text, s: style }]);
  if (width === undefined) return c;
  return padCells(c, width);
}

export { concatCells, blankCells };
