/**
 * Markdown parsing.
 *
 * Deliberately renderer-independent and streaming-tolerant: an unterminated
 * fence is still a code block (`closed: false`), which is exactly what happens
 * for most of a streamed answer. The parser never throws on partial input.
 */

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  underline?: boolean;
  link?: string;
  /** Setext/heading emphasis not needed — spans are already granular. */
}

export interface ListItem {
  /** Indent level, 0-based. */
  level: number;
  ordered: boolean;
  /** Rendered marker, e.g. "1." or "•". */
  marker: string;
  text: string;
  /** Task-list state when the item is `[ ]` / `[x]`. */
  checked: boolean | null;
}

export type Align = "left" | "right" | "center";

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lang: string; meta: string; code: string; closed: boolean }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; header: string[]; align: Align[]; rows: string[][] }
  | { kind: "hr" }
  | { kind: "blank" };

const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const UL_RE = /^(\s*)([-*+])\s+(.*)$/;
const OL_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function parseAlign(sep: string): Align[] {
  return splitTableRow(sep).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

/** Parse markdown into blocks. Tolerant of incomplete input by design. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const pushParagraph = (buf: string[]) => {
    if (!buf.length) return;
    blocks.push({ kind: "paragraph", text: buf.join("\n").trim() });
    buf.length = 0;
  };

  let para: string[] = [];

  while (i < lines.length) {
    const line = lines[i]!;

    // fenced code
    const fence = FENCE_RE.exec(line);
    if (fence) {
      pushParagraph(para);
      const indent = fence[1]!.length;
      const marker = fence[2]!;
      const lang = fence[3] ?? "";
      const meta = (fence[4] ?? "").trim();
      const body: string[] = [];
      let closed = false;
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        const close = FENCE_RE.exec(l);
        if (close && close[2]!.startsWith(marker[0]!) && close[1]!.length <= indent + 3) {
          closed = true;
          i++;
          break;
        }
        // Strip the block's own indentation, matching CommonMark behaviour.
        body.push(indent > 0 ? l.replace(new RegExp(`^ {0,${indent}}`), "") : l);
        i++;
      }
      blocks.push({ kind: "code", lang, meta, code: body.join("\n"), closed });
      continue;
    }

    if (line.trim() === "") {
      pushParagraph(para);
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      pushParagraph(para);
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      pushParagraph(para);
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      pushParagraph(para);
      const parts: string[] = [];
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i]!);
        if (!q) break;
        parts.push(q[1]!);
        i++;
      }
      blocks.push({ kind: "quote", text: parts.join("\n") });
      continue;
    }

    // table: a header row followed by a separator row
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      pushParagraph(para);
      const header = splitTableRow(line);
      const align = parseAlign(lines[i + 1]!);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) {
        rows.push(splitTableRow(lines[i]!));
        i++;
      }
      blocks.push({ kind: "table", header, align, rows });
      continue;
    }

    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul || ol) {
      pushParagraph(para);
      const items: ListItem[] = [];
      let ordered = Boolean(ol);
      const start = ol ? Number.parseInt(ol[2]!, 10) : 1;
      while (i < lines.length) {
        const l = lines[i]!;
        const u = UL_RE.exec(l);
        const o = OL_RE.exec(l);
        if (!u && !o) {
          // Continuation line of the previous item.
          if (l.trim() !== "" && items.length && /^\s{2,}/.test(l)) {
            const last = items[items.length - 1]!;
            last.text += "\n" + l.trim();
            i++;
            continue;
          }
          break;
        }
        const match = u ?? o!;
        const indent = match[1]!.replace(/\t/g, "  ").length;
        const level = Math.max(0, Math.floor(indent / 2));
        let text = match[3]!;
        let checked: boolean | null = null;
        const task = TASK_RE.exec(text);
        if (task) {
          checked = task[1]!.toLowerCase() === "x";
          text = task[2]!;
        }
        items.push({
          level,
          ordered: Boolean(o),
          marker: o ? `${o[2]!}.` : "•",
          text,
          checked,
        });
        i++;
      }
      blocks.push({ kind: "list", ordered, start, items });
      continue;
    }

    para.push(line);
    i++;
  }
  pushParagraph(para);
  return blocks;
}

const INLINE_RE =
  /(`[^`\n]+`|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~|!\[[^\]\n]*\]\([^)\s]+(?:\s+"[^"]*")?\)|\[[^\]\n]+\]\([^)\s]+(?:\s+"[^"]*")?\)|<https?:\/\/[^>\s]+>|https?:\/\/[^\s<>()]+[^\s<>().,;:'"!?])/g;

/** Parse inline markdown into styled spans. */
export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) spans.push({ text: text.slice(last, idx) });
    const raw = m[0];
    if (raw.startsWith("`")) {
      spans.push({ text: raw.slice(1, -1), code: true });
    } else if (raw.startsWith("***") || raw.startsWith("___")) {
      spans.push({ text: raw.slice(3, -3), bold: true, italic: true });
    } else if (raw.startsWith("**") || raw.startsWith("__")) {
      spans.push({ text: raw.slice(2, -2), bold: true });
    } else if (raw.startsWith("~~")) {
      spans.push({ text: raw.slice(2, -2), strike: true });
    } else if (raw.startsWith("*") || raw.startsWith("_")) {
      spans.push({ text: raw.slice(1, -1), italic: true });
    } else if (raw.startsWith("![")) {
      const link = /\((.*?)\)\s*$/.exec(raw);
      const alt = /^!\[(.*?)\]/.exec(raw);
      spans.push({ text: `🖼 ${alt?.[1] || "image"}`, italic: true, link: link?.[1] });
    } else if (raw.startsWith("[")) {
      const mm = /^\[(.*?)\]\((.*?)\)$/.exec(raw);
      if (mm) spans.push({ text: mm[1]!, link: mm[2]!.replace(/\s+"[^"]*"$/, ""), underline: true });
      else spans.push({ text: raw });
    } else if (raw.startsWith("<http")) {
      const url = raw.slice(1, -1);
      spans.push({ text: url, link: url });
    } else if (raw.startsWith("http")) {
      spans.push({ text: raw, link: raw });
    } else {
      spans.push({ text: raw });
    }
    last = idx + raw.length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans;
}

/** True when a markdown document contains at least one code block. */
export function hasCode(text: string): boolean {
  return /(^|\n)\s*(`{3,}|~{3,})/.test(text);
}

/** Extract fenced code blocks — used for "copy the Nth block" affordances. */
export function extractCodeBlocks(source: string): Array<{ lang: string; code: string; meta: string }> {
  return parseMarkdown(source)
    .filter((b): b is Extract<Block, { kind: "code" }> => b.kind === "code")
    .map((b) => ({ lang: b.lang, code: b.code, meta: b.meta }));
}
