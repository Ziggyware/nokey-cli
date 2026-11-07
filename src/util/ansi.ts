/**
 * Capability-aware ANSI serialisation.
 *
 * Cells carry abstract styles; this module decides how (or whether) to express
 * them, so the same frame renders on a truecolor terminal, a 256-colour tmux
 * pane, a 16-colour console, or a dumb pipe (`NO_COLOR`, non-TTY).
 */
import type { Cell, Color, Style } from "./cells.ts";

export type ColorMode = "truecolor" | "256" | "16" | "none";

export interface RenderOptions {
  colorMode: ColorMode;
  /** Hyperlink support (OSC 8). */
  hyperlinks?: boolean;
}

export function detectColorMode(env: NodeJS.ProcessEnv = process.env, isTTY = process.stdout.isTTY === true): ColorMode {
  const forced = env.FORCE_COLOR?.trim().toLowerCase();
  if (forced === "0" || forced === "false") return "none";
  if (env.NO_COLOR && env.NO_COLOR.trim() !== "") return "none";
  if (!isTTY && forced === undefined) return "none";
  if (forced === "1" || forced === "true") {
    return env.COLORTERM?.includes("truecolor") || env.COLORTERM?.includes("24bit") ? "truecolor" : "256";
  }
  if (forced === "3" || forced === "truecolor") return "truecolor";
  if (forced === "2") return "256";
  if (env.TERM === "dumb") return "none";
  const ct = env.COLORTERM ?? "";
  if (ct.includes("truecolor") || ct.includes("24bit")) return "truecolor";
  const term = env.TERM ?? "";
  if (term.includes("direct")) return "truecolor";
  if (term.includes("256")) return "256";
  if (term === "" && env.TERM_PROGRAM) return "truecolor";
  return "16";
}

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function parseHex(color: string): [number, number, number] | null {
  if (!HEX_RE.test(color)) return null;
  let hex = color.slice(1);
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const n = Number.parseInt(hex, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** xterm 256-colour palette index nearest to an RGB triple. */
export function rgbTo256(r: number, g: number, b: number): number {
  const avg = (r + g + b) / 3;
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    // Greyscale ramp 232..255.
    if (avg < 8) return 16;
    if (avg > 238) return 231;
    return 232 + Math.round(((avg - 8) / 230) * 23);
  }
  const toCube = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * toCube(r) + 6 * toCube(g) + toCube(b);
}

/** Closest of the 16 basic ANSI colours. */
export function rgbTo16(r: number, g: number, b: number): number {
  const base: Array<[number, number, number]> = [
    [0, 0, 0],
    [205, 49, 49],
    [13, 188, 121],
    [229, 229, 16],
    [36, 114, 200],
    [188, 63, 188],
    [17, 168, 205],
    [229, 229, 229],
    [102, 102, 102],
    [241, 76, 76],
    [35, 209, 139],
    [245, 245, 67],
    [59, 142, 234],
    [214, 112, 214],
    [41, 184, 219],
    [255, 255, 255],
  ];
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < base.length; i++) {
    const [br, bg, bb] = base[i]!;
    const d = (r - br) ** 2 + (g - bg) ** 2 + (b - bb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function colorArgs(color: Color, mode: ColorMode, background: boolean): string | null {
  if (mode === "none") return null;
  if (color === "default") return background ? "49" : "39";
  if (color.startsWith("ansi:")) {
    const n = Number.parseInt(color.slice(5), 10);
    if (!Number.isFinite(n)) return null;
    if (mode === "16" && n > 15) {
      const rgb = n >= 16 ? null : null;
      void rgb;
      return background ? "49" : "39";
    }
    return `${background ? 48 : 38};5;${n}`;
  }
  const rgb = parseHex(color);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  if (mode === "truecolor") return `${background ? 48 : 38};2;${r};${g};${b}`;
  if (mode === "256") return `${background ? 48 : 38};5;${rgbTo256(r, g, b)}`;
  const idx = rgbTo16(r, g, b);
  // 16-colour SGR: 30-37 / 90-97 foreground, 40-47 / 100-107 background.
  const code = background
    ? idx < 8
      ? 40 + idx
      : 100 + (idx - 8)
    : idx < 8
      ? 30 + idx
      : 90 + (idx - 8);
  return String(code);
}

function styleKey(s: Style | null, mode: ColorMode): string {
  if (!s) return "";
  return [
    mode,
    s.fg ?? "",
    s.bg ?? "",
    s.bold ? 1 : 0,
    s.dim ? 1 : 0,
    s.italic ? 1 : 0,
    s.underline ? 1 : 0,
    s.strike ? 1 : 0,
    s.reverse ? 1 : 0,
  ].join("|");
}

const SGR_CACHE = new Map<string, string>();

/** Escape sequence (empty when the style is a no-op) that activates `s`. */
export function sgr(s: Style | null, mode: ColorMode): string {
  if (!s || mode === "none") return "";
  const key = styleKey(s, mode);
  const hit = SGR_CACHE.get(key);
  if (hit !== undefined) return hit;
  const parts: string[] = [];
  const fg = s.fg ? colorArgs(s.fg, mode, false) : null;
  const bg = s.bg ? colorArgs(s.bg, mode, true) : null;
  if (fg) parts.push(fg);
  if (bg) parts.push(bg);
  if (s.bold) parts.push("1");
  if (s.dim) parts.push("2");
  if (s.italic) parts.push("3");
  if (s.underline) parts.push("4");
  if (s.reverse) parts.push("7");
  if (s.strike) parts.push("9");
  const seq = parts.length ? `\x1b[${parts.join(";")}m` : "";
  if (SGR_CACHE.size < 4096) SGR_CACHE.set(key, seq);
  return seq;
}

/** Serialise one line of cells. Always ends with a reset so backgrounds do not bleed. */
export function lineToAnsi(line: Cell[], opts: RenderOptions): string {
  if (line.length === 0) return "";
  if (opts.colorMode === "none") {
    let out = "";
    for (const c of line) out += c.t;
    return out;
  }
  let out = "";
  let current = "";
  for (const c of line) {
    const key = styleKey(c.s, opts.colorMode);
    if (key !== current) {
      out += "\x1b[0m";
      const seq = sgr(c.s, opts.colorMode);
      if (seq) out += seq;
      current = key;
    }
    out += c.t;
  }
  out += "\x1b[0m";
  return out;
}

/** OSC 8 hyperlink wrapper. */
export function hyperlink(text: string, url: string, enabled: boolean): string {
  if (!enabled) return text;
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/** Strip every escape sequence — used for clipboard/export/plain output. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[a-zA-Z]|\x1b[@-_]/g, "");
}
