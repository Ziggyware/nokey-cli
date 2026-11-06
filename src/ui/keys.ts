/**
 * Key decoding.
 *
 * One parser for the escape sequences terminals actually send: CSI arrows,
 * modifier-encoded arrows (`\x1b[1;5C`), home/end variants, function keys,
 * bracketed paste, focus events and the classic control bytes. Paste content is
 * returned as a single event so a 400-line paste does not fire 400 renders.
 */

export interface KeyEvent {
  /** Logical name: "a", "enter", "up", "f1", … */
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Printable text (may be multi-grapheme). */
  text?: string;
  /** Set for bracketed-paste payloads. */
  paste?: string;
  /** Raw sequence, for debugging with `--keys`. */
  raw?: string;
}

const CSI_PREFIX = "\x1b[";
const SS3_PREFIX = "\x1bO";

const CSI_KEYS: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "tab",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
  M: "mouse",
  "1~": "home",
  "2~": "insert",
  "3~": "delete",
  "4~": "end",
  "5~": "pgup",
  "6~": "pgdn",
  "7~": "home",
  "8~": "end",
  "11~": "f1",
  "12~": "f2",
  "13~": "f3",
  "14~": "f4",
  "15~": "f5",
  "17~": "f6",
  "18~": "f7",
  "19~": "f8",
  "20~": "f9",
  "21~": "f10",
  "23~": "f11",
  "24~": "f12",
};

const CTRL_NAMES: Record<string, string> = {
  "\x00": "space",
  "\x01": "a",
  "\x02": "b",
  "\x03": "c",
  "\x04": "d",
  "\x05": "e",
  "\x06": "f",
  "\x07": "g",
  "\x08": "backspace",
  "\x09": "tab",
  "\x0a": "newline",
  "\x0b": "k",
  "\x0c": "l",
  "\x0d": "enter",
  "\x0e": "n",
  "\x0f": "o",
  "\x10": "p",
  "\x11": "q",
  "\x12": "r",
  "\x13": "s",
  "\x14": "t",
  "\x15": "u",
  "\x16": "v",
  "\x17": "w",
  "\x18": "x",
  "\x19": "y",
  "\x1a": "z",
  "\x1b": "escape",
  "\x1c": "backslash",
  "\x1d": "bracketright",
  "\x1e": "caret",
  "\x1f": "underscore",
  "\x7f": "backspace",
};

/**
 * Parse a raw chunk into key events. Incomplete trailing sequences are kept in
 * `pending` and returned so the caller can prepend the next chunk.
 */
export function parseKeys(chunk: string, pending = ""): { keys: KeyEvent[]; pending: string } {
  const input = pending + chunk;
  const keys: KeyEvent[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    // Bracketed paste: consume verbatim up to the terminator.
    if (input.startsWith("\x1b[200~", i)) {
      const end = input.indexOf("\x1b[201~", i + 6);
      if (end === -1) return { keys, pending: input.slice(i) };
      keys.push({ key: "paste", ctrl: false, alt: false, shift: false, paste: input.slice(i + 6, end) });
      i = end + 6;
      continue;
    }

    // Focus in/out — ignore, but consume so it does not look like alt chars.
    if (input.startsWith("\x1b[I", i) || input.startsWith("\x1b[O", i)) {
      i += 3;
      continue;
    }

    if (ch === "\x1b") {
      // Bare escape (no following byte): the user pressed Esc.
      if (i + 1 >= input.length) {
        keys.push({ key: "escape", ctrl: false, alt: false, shift: false });
        i++;
        continue;
      }
      const next = input[i + 1]!;

      if (next === "[") {
        const parsed = parseCsi(input, i);
        if (!parsed) return { keys, pending: input.slice(i) };
        keys.push(parsed.key);
        i = parsed.end;
        continue;
      }
      if (next === "O") {
        const seq = input[i + 2];
        if (!seq) return { keys, pending: input.slice(i) };
        const name = CSI_KEYS[seq] ?? seq;
        keys.push({ key: name, ctrl: false, alt: false, shift: false, raw: input.slice(i, i + 3) });
        i += 3;
        continue;
      }
      if (next === "\x1b") {
        // Two escapes in a row: treat as a single Esc press.
        keys.push({ key: "escape", ctrl: false, alt: false, shift: false });
        i += 2;
        continue;
      }
      // Alt + control keys (alt+enter is the newline chord in most terminals).
      const altChar = input[i + 1]!;
      if (altChar === "\r" || altChar === "\n") {
        keys.push({ key: "enter", ctrl: false, alt: true, shift: false, raw: input.slice(i, i + 2) });
        i += 2;
        continue;
      }
      if (CTRL_NAMES[altChar]) {
        keys.push({ key: CTRL_NAMES[altChar]!, ctrl: false, alt: true, shift: false, raw: input.slice(i, i + 2) });
        i += 2;
        continue;
      }
      // Alt + key
      const { key, length } = decodeSimple(input, i + 1);
      keys.push({ key, ctrl: false, alt: true, shift: false, ...(key.length === 1 ? { text: key } : {}), raw: input.slice(i, i + 1 + length) });
      i += 1 + length;
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      keys.push({ key: "enter", ctrl: false, alt: false, shift: false, raw: ch });
      i++;
      continue;
    }

    const ctrlName = CTRL_NAMES[ch];
    if (ctrlName) {
      keys.push({
        key: ctrlName,
        ctrl: ch !== "\x7f" && ch !== "\x08" && ch !== "\x09" && ch !== "\x0d" && ch !== "\x0a",
        alt: false,
        shift: false,
        raw: ch,
      });
      i++;
      continue;
    }

    const { key, length } = decodeSimple(input, i);
    keys.push({ key, ctrl: false, alt: false, shift: false, text: input.slice(i, i + length) });
    i += length;
  }

  return { keys, pending: "" };
}

function decodeSimple(input: string, at: number): { key: string; length: number } {
  const code = input.codePointAt(at);
  if (code === undefined) return { key: "", length: 1 };
  const ch = input[at]!;
  // Grapheme-ish: include following combining marks / ZWJ sequences / VS16.
  let end = at + ch.length;
  while (end < input.length) {
    const nextCode = input.codePointAt(end)!;
    const isMark = (nextCode >= 0x0300 && nextCode <= 0x036f) || (nextCode >= 0xfe00 && nextCode <= 0xfe0f) || nextCode === 0x200d;
    if (isMark) {
      end += input[end]!.length;
      continue;
    }
    if (input[end - 1] === "\u200d") {
      end += input[end]!.length;
      continue;
    }
    break;
  }
  return { key: input.slice(at, end), length: end - at };
}

interface ParsedCsi {
  key: KeyEvent;
  end: number;
}

function parseCsi(input: string, start: number): ParsedCsi | null {
  // ESC [ <params> <final>
  let i = start + 2;
  let params = "";
  while (i < input.length) {
    const ch = input[i]!;
    const code = ch.charCodeAt(0);
    if (code >= 0x30 && code <= 0x3f) {
      params += ch;
      i++;
      continue;
    }
    if (code >= 0x20 && code <= 0x2f) {
      params += ch;
      i++;
      continue;
    }
    // Final byte
    const final = ch;
    const raw = input.slice(start, i + 1);
    const parts = params.split(";");
    const base = parts[0] ?? "";
    const mod = Number(parts[1] ?? "");
    const ctrl = Number.isFinite(mod) && (mod === 5 || mod === 6 || mod === 7 || mod === 13 || mod === 14);
    const alt = Number.isFinite(mod) && (mod === 3 || mod === 4 || mod === 7 || mod === 8 || mod === 11 || mod === 12);
    const shift = Number.isFinite(mod) && (mod === 2 || mod === 4 || mod === 6 || mod === 8 || mod === 10 || mod === 12 || mod === 14);

    if (final === "~") {
      const name = CSI_KEYS[`${base}~`] ?? CSI_KEYS[`${base};${mod}~`];
      if (name) return { key: { key: name, ctrl, alt, shift, raw }, end: i + 1 };
      if (base === "200") {
        // Handled by the paste scanner above; treat stray as no-op.
        return { key: { key: "noop", ctrl: false, alt: false, shift: false, raw }, end: i + 1 };
      }
      return { key: { key: "noop", ctrl: false, alt: false, shift: false, raw }, end: i + 1 };
    }

    if (final === "M" || final === "m") {
      // Mouse event (xterm SGR). Swallow — the CLI scrolls by keyboard.
      return { key: { key: "mouse", ctrl: false, alt: false, shift: false, raw }, end: i + 1 };
    }

    const name = CSI_KEYS[final];
    if (name) {
      return { key: { key: name, ctrl, alt, shift, raw }, end: i + 1 };
    }
    return { key: { key: "noop", ctrl: false, alt: false, shift: false, raw }, end: i + 1 };
  }
  return null;
}

/** Pretty name for the help sheet. */
export function describeKey(ev: KeyEvent): string {
  const mods = [ev.ctrl ? "Ctrl" : "", ev.alt ? "Alt" : "", ev.shift ? "Shift" : ""].filter(Boolean).join("+");
  const base = ev.key.length === 1 ? ev.key.toUpperCase() : ev.key.replace(/^(\w)/, (m) => m.toUpperCase());
  return mods ? `${mods}+${base}` : base;
}
