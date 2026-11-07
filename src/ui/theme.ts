/**
 * Colour system.
 *
 * Everything visible is addressed by a semantic token (`kw`, `user`, `memory`,
 * …) rather than a literal colour. Themes swap the palette; the renderer never
 * hard-codes a hex value. That is what makes the whole UI re-colourable at
 * runtime with `/theme`.
 */
import type { Style } from "../util/cells.ts";

export type Token =
  // canvas
  | "fg"
  | "bg"
  | "muted"
  | "faint"
  | "border"
  | "borderActive"
  // brand / chrome
  | "accent"
  | "accent2"
  | "accent3"
  | "chip"
  | "chipBg"
  | "chipActiveBg"
  // roles
  | "user"
  | "userBg"
  | "assistant"
  | "assistantBg"
  | "reasoning"
  | "reasoningBg"
  | "tool"
  | "toolBg"
  | "toolResult"
  | "system"
  | "summary"
  | "memory"
  | "error"
  | "warn"
  | "ok"
  | "info"
  // markdown
  | "h1"
  | "h2"
  | "h3"
  | "quote"
  | "link"
  | "hr"
  | "listMark"
  | "codeBorder"
  | "codeBg"
  | "codeLang"
  | "inlineBg"
  | "tableBorder"
  | "tableHeader"
  // syntax
  | "kw"
  | "str"
  | "num"
  | "comment"
  | "fn"
  | "type"
  | "var"
  | "op"
  | "punct"
  | "regex"
  | "tag"
  | "attr"
  | "builtin"
  | "meta"
  | "escape"
  | "added"
  | "removed"
  | "addedBg"
  | "removedBg"
  | "diffHunk"
  // ui
  | "selectionBg"
  | "cursor"
  | "statusBg"
  | "statusFg"
  | "inputBg"
  | "prompt"
  | "placeholder"
  | "spinner";

export type Palette = Record<Token, string>;

export interface Theme {
  name: string;
  label: string;
  /** Intended for dark or light terminals. */
  variant: "dark" | "light";
  palette: Palette;
  /** Per-role gutter glyphs — the colour-coding backbone of the transcript. */
  glyphs: {
    user: string;
    assistant: string;
    reasoning: string;
    tool: string;
    toolResult: string;
    system: string;
    summary: string;
    memory: string;
    error: string;
  };
}

const darkGlyphs = {
  user: "◆",
  assistant: "●",
  reasoning: "◇",
  tool: "⚙",
  toolResult: "↳",
  system: "ⓘ",
  summary: "∑",
  memory: "✦",
  error: "✖",
};

const lightGlyphs = { ...darkGlyphs };

/** Midnight — the default: deep navy canvas, cool cyans, warm accents. */
const midnight: Palette = {
  fg: "#e6edf3",
  bg: "#0b0f14",
  muted: "#8b98a5",
  faint: "#5a6672",
  border: "#22303c",
  borderActive: "#3d7ea6",
  accent: "#5ad1ff",
  accent2: "#b48cff",
  accent3: "#ffd479",
  chip: "#0f1a24",
  chipBg: "#132433",
  chipActiveBg: "#1d3b52",
  user: "#7ee3ff",
  userBg: "#0d1c26",
  assistant: "#8df0b6",
  assistantBg: "#0c1a15",
  reasoning: "#b8a4ff",
  reasoningBg: "#12101f",
  tool: "#ffc46b",
  toolBg: "#1e1608",
  toolResult: "#79b8ff",
  system: "#93a1b1",
  summary: "#c3a6ff",
  memory: "#ff9ad5",
  error: "#ff6b6b",
  warn: "#ffb86b",
  ok: "#7ee787",
  info: "#79c0ff",
  h1: "#5ad1ff",
  h2: "#8df0b6",
  h3: "#b48cff",
  quote: "#93a1b1",
  link: "#79b8ff",
  hr: "#22303c",
  listMark: "#5ad1ff",
  codeBorder: "#2b3d4d",
  codeBg: "#0a1118",
  codeLang: "#7d8b99",
  inlineBg: "#17222c",
  tableBorder: "#2b3d4d",
  tableHeader: "#8df0b6",
  kw: "#ff7eb6",
  str: "#9ae6a0",
  num: "#ffb86b",
  comment: "#6b7b8c",
  fn: "#79c0ff",
  type: "#ffd479",
  var: "#e6edf3",
  op: "#ff9ad5",
  punct: "#8b98a5",
  regex: "#ffc46b",
  tag: "#ff7eb6",
  attr: "#ffd479",
  builtin: "#5ad1ff",
  meta: "#b8a4ff",
  escape: "#ffb86b",
  added: "#7ee787",
  removed: "#ff6b6b",
  addedBg: "#0d2018",
  removedBg: "#26100f",
  diffHunk: "#b48cff",
  selectionBg: "#1d3b52",
  cursor: "#5ad1ff",
  statusBg: "#0f1a24",
  statusFg: "#c9d6e2",
  inputBg: "#0d1720",
  prompt: "#5ad1ff",
  placeholder: "#5a6672",
  spinner: "#5ad1ff",
};

/** Aurora — higher contrast, magenta/green split, for bright rooms. */
const aurora: Palette = {
  ...midnight,
  bg: "#0d0b14",
  fg: "#efe9ff",
  muted: "#9d94b8",
  faint: "#6b6485",
  border: "#2c2543",
  borderActive: "#7a5cff",
  accent: "#00e5c0",
  accent2: "#c77dff",
  accent3: "#ffd166",
  chipBg: "#1a1430",
  chipActiveBg: "#2b2150",
  user: "#00e5c0",
  userBg: "#0c1b1a",
  assistant: "#a5ff8d",
  assistantBg: "#111d0c",
  reasoning: "#c77dff",
  reasoningBg: "#170f26",
  tool: "#ffb703",
  toolResult: "#8ecae6",
  memory: "#ff70a6",
  codeBg: "#100c1b",
  codeBorder: "#322a4d",
  inlineBg: "#1c1633",
  tableBorder: "#322a4d",
  kw: "#ff70a6",
  str: "#a5ff8d",
  num: "#ffb703",
  fn: "#8ecae6",
  type: "#ffd166",
  op: "#c77dff",
  builtin: "#00e5c0",
  link: "#8ecae6",
  h1: "#00e5c0",
  h2: "#a5ff8d",
  h3: "#c77dff",
  statusBg: "#171029",
  statusFg: "#ded4ff",
  inputBg: "#130f22",
  prompt: "#00e5c0",
  spinner: "#c77dff",
  selectionBg: "#2b2150",
  cursor: "#00e5c0",
};

/** Daylight — a light variant for terminals with light backgrounds. */
const daylight: Palette = {
  fg: "#1b2430",
  bg: "#fbfcfe",
  muted: "#5c6b7a",
  faint: "#8b98a5",
  border: "#d3dde7",
  borderActive: "#2f6feb",
  accent: "#0b6bcb",
  accent2: "#7a3fd1",
  accent3: "#a86800",
  chip: "#eef3f8",
  chipBg: "#eaf1f8",
  chipActiveBg: "#d6e6f6",
  user: "#0b6bcb",
  userBg: "#eef5fd",
  assistant: "#116b3f",
  assistantBg: "#eefaf2",
  reasoning: "#6b3fd1",
  reasoningBg: "#f4f0ff",
  tool: "#8a5a00",
  toolBg: "#fff8e6",
  toolResult: "#1f5fa8",
  system: "#5c6b7a",
  summary: "#6b3fd1",
  memory: "#b3247a",
  error: "#c1121f",
  warn: "#a86800",
  ok: "#116b3f",
  info: "#0b6bcb",
  h1: "#0b6bcb",
  h2: "#116b3f",
  h3: "#7a3fd1",
  quote: "#5c6b7a",
  link: "#0b6bcb",
  hr: "#d3dde7",
  listMark: "#0b6bcb",
  codeBorder: "#cfdae5",
  codeBg: "#f4f7fa",
  codeLang: "#68798a",
  inlineBg: "#eaf0f6",
  tableBorder: "#cfdae5",
  tableHeader: "#116b3f",
  kw: "#af1d6d",
  str: "#116b3f",
  num: "#a86800",
  comment: "#7d8b99",
  fn: "#1f5fa8",
  type: "#8a5a00",
  var: "#1b2430",
  op: "#af1d6d",
  punct: "#5c6b7a",
  regex: "#a86800",
  tag: "#af1d6d",
  attr: "#8a5a00",
  builtin: "#0b6bcb",
  meta: "#7a3fd1",
  escape: "#a86800",
  added: "#116b3f",
  removed: "#c1121f",
  addedBg: "#eafaf0",
  removedBg: "#fdeeee",
  diffHunk: "#7a3fd1",
  selectionBg: "#d6e6f6",
  cursor: "#0b6bcb",
  statusBg: "#eef3f8",
  statusFg: "#26333f",
  inputBg: "#f2f6fa",
  prompt: "#0b6bcb",
  placeholder: "#8b98a5",
  spinner: "#0b6bcb",
};

/** Mono — no colour at all; glyphs and weight carry the meaning. */
const mono: Palette = new Proxy({} as Palette, {
  get: (_t, prop) => {
    if (prop === "bg") return "default";
    return "default";
  },
}) as Palette;

/** Protanopia/deuteranopia-safe: blue/amber axis instead of red/green. */
const accessible: Palette = {
  ...midnight,
  bg: "#08090c",
  fg: "#eceff4",
  accent: "#4da3ff",
  accent2: "#f5a623",
  accent3: "#8cd0ff",
  user: "#4da3ff",
  assistant: "#8cd0ff",
  reasoning: "#c3a6ff",
  tool: "#f5a623",
  toolResult: "#79c0ff",
  memory: "#e07be0",
  ok: "#4da3ff",
  warn: "#f5a623",
  error: "#ff8f5a",
  added: "#4da3ff",
  removed: "#f5a623",
  str: "#8cd0ff",
  kw: "#c3a6ff",
  num: "#f5a623",
  fn: "#79c0ff",
  type: "#ffd479",
  h1: "#4da3ff",
  h2: "#8cd0ff",
  h3: "#c3a6ff",
  listMark: "#4da3ff",
};

export const THEMES: Record<string, Theme> = {
  midnight: { name: "midnight", label: "Midnight — deep navy, cyan accents", variant: "dark", palette: midnight, glyphs: darkGlyphs },
  aurora: { name: "aurora", label: "Aurora — violet/mint, high contrast", variant: "dark", palette: aurora, glyphs: darkGlyphs },
  accessible: { name: "accessible", label: "Accessible — blue/amber, colour-vision safe", variant: "dark", palette: accessible, glyphs: darkGlyphs },
  daylight: { name: "daylight", label: "Daylight — light terminals", variant: "light", palette: daylight, glyphs: lightGlyphs },
  mono: { name: "mono", label: "Mono — no colour, weight only", variant: "dark", palette: mono, glyphs: darkGlyphs },
};

export const THEME_NAMES = Object.keys(THEMES);

export function getTheme(name: string | undefined): Theme {
  if (name && THEMES[name]) return THEMES[name]!;
  return THEMES.midnight!;
}

/** Build a Style from a theme token plus optional modifiers. */
export function st(theme: Theme, token: Token, extra: Partial<Style> = {}): Style {
  const color = theme.palette[token] ?? theme.palette.fg;
  return { fg: color, ...extra };
}

/** A style with both foreground and background from the palette. */
export function stBg(theme: Theme, fgToken: Token, bgToken: Token, extra: Partial<Style> = {}): Style {
  return { fg: theme.palette[fgToken], bg: theme.palette[bgToken], ...extra };
}

/** ANSI 24-bit escape for a single colour — used by the one-shot printer. */
export function hexToEscape(hex: string, background = false): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "";
  const n = Number.parseInt(m[1]!, 16);
  return `\x1b[${background ? 48 : 38};2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}
