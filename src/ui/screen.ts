/**
 * Terminal screen.
 *
 * Alternate-screen buffer with line-diffed repainting: only rows whose content
 * actually changed are rewritten, and each write is a single cursor jump. That
 * keeps streaming at 60 fps cheap even over SSH.
 */
import type { ReadStream, WriteStream } from "node:tty";

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR = "\x1b[2J\x1b[H";
const MOUSE_ON = "\x1b[?1002h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1002l\x1b[?1006l";
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";
const FOCUS_ON = "\x1b[?1004h";
const FOCUS_OFF = "\x1b[?1004l";

export interface Size {
  cols: number;
  rows: number;
}

export class Screen {
  #out: WriteStream;
  #input: ReadStream;
  #prev: string[] = [];
  #started = false;
  #cursorVisible = false;

  constructor(out: WriteStream, input: ReadStream) {
    this.#out = out;
    this.#input = input;
  }

  get started(): boolean {
    return this.#started;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#out.write(`${ALT_ON}${CLEAR}${HIDE_CURSOR}${PASTE_ON}${FOCUS_ON}`);
    this.#prev = [];
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#out.write(`${SHOW_CURSOR}${PASTE_OFF}${FOCUS_OFF}${MOUSE_OFF}${ALT_OFF}`);
  }

  /** Kill the alternate screen without leaving artifacts (used on crash). */
  panic(message: string): void {
    try {
      this.#out.write(`${SHOW_CURSOR}${PASTE_OFF}${FOCUS_OFF}${ALT_OFF}`);
      this.#out.write(`${message}\n`);
    } catch {
      /* ignore */
    }
  }

  size(): Size {
    return { cols: Math.max(20, this.#out.columns || 80), rows: Math.max(8, this.#out.rows || 24) };
  }

  enableMouse(): void {
    this.#out.write(MOUSE_ON);
  }

  disableMouse(): void {
    this.#out.write(MOUSE_OFF);
  }

  write(data: string): void {
    this.#out.write(data);
  }

  /** Invalidate the diff cache (resize, external clear, overlay swap). */
  invalidate(): void {
    this.#prev = [];
    this.#out.write(CLEAR);
  }

  /**
   * Paint the frame. `lines` must be exactly `rows` long (ANSI strings).
   * When `cursor` is given the real cursor is placed there.
   */
  paint(lines: string[], cursor?: { row: number; col: number }): void {
    const { rows, cols } = this.size();
    let buf = "";
    for (let i = 0; i < rows; i++) {
      const line = lines[i] ?? "";
      if (this.#prev[i] === line) continue;
      buf += `\x1b[${i + 1};1H${line}\x1b[0m\x1b[K`;
      this.#prev[i] = line;
    }
    if (buf.length) this.#out.write(buf);
    if (cursor) {
      const row = Math.min(rows, Math.max(1, cursor.row + 1));
      const col = Math.min(cols, Math.max(1, cursor.col + 1));
      this.#out.write(`\x1b[${row};${col}H${SHOW_CURSOR}`);
      this.#cursorVisible = true;
    } else if (this.#cursorVisible) {
      this.#out.write(HIDE_CURSOR);
      this.#cursorVisible = false;
    }
  }

  onResize(cb: (size: Size) => void): () => void {
    const handler = () => {
      this.invalidate();
      cb(this.size());
    };
    this.#out.on("resize", handler);
    return () => this.#out.off("resize", handler);
  }

  onInput(cb: (chunk: string) => void): () => void {
    const handler = (chunk: Buffer) => cb(chunk.toString("utf8"));
    this.#input.on("data", handler);
    return () => this.#input.off("data", handler);
  }

  setRaw(on: boolean): void {
    if (this.#input.isTTY) {
      this.#input.setRawMode(on);
      if (on) this.#input.resume();
    }
  }

  /** Terminal bell, used when a long answer completes off-screen. */
  bell(): void {
    this.#out.write("\x07");
  }
}
