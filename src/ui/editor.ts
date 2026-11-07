/**
 * The composer.
 *
 * A small line editor with hard-wrapped display (so the real cursor position is
 * always exact), history, word motions and multi-line input. Slash autocomplete
 * reads `slashPrefix()`; the app owns the suggestion list.
 */
import { graphemes } from "../util/cells.ts";

export type CursorStyle = "block" | "bar";

export interface EditorView {
  /** Visual lines of the buffer, already wrapped to `width`. */
  lines: string[];
  /** Cursor position in visual space. */
  row: number;
  col: number;
  /** First visual line shown when the buffer is taller than the viewport. */
  scroll: number;
}

export class Composer {
  value = "";
  cursor = 0;
  history: string[] = [];
  historyIndex = -1;
  #draft = "";
  /** Visual scroll offset when the input exceeds the max height. */
  scroll = 0;

  get isEmpty(): boolean {
    return this.value.length === 0;
  }

  get isMultiline(): boolean {
    return this.value.includes("\n");
  }

  set(value: string, cursor = value.length): void {
    this.value = value;
    this.cursor = Math.max(0, Math.min(value.length, cursor));
  }

  clear(): void {
    this.value = "";
    this.cursor = 0;
    this.historyIndex = -1;
    this.#draft = "";
    this.scroll = 0;
  }

  insert(text: string): void {
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
  }

  insertNewline(): void {
    this.insert("\n");
  }

  #prevIndex(): number {
    if (this.cursor === 0) return -1;
    const graphemesBefore = graphemes(this.value.slice(0, this.cursor));
    const last = graphemesBefore[graphemesBefore.length - 1];
    return last ? this.cursor - last.length : -1;
  }

  backspace(): void {
    const prev = this.#prevIndex();
    if (prev < 0) return;
    this.value = this.value.slice(0, prev) + this.value.slice(this.cursor);
    this.cursor = prev;
  }

  deleteForward(): void {
    if (this.cursor >= this.value.length) return;
    const rest = graphemes(this.value.slice(this.cursor));
    const first = rest[0] ?? "";
    this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + first.length);
  }

  moveLeft(): void {
    const prev = this.#prevIndex();
    if (prev >= 0) this.cursor = prev;
  }

  moveRight(): void {
    if (this.cursor >= this.value.length) return;
    const rest = graphemes(this.value.slice(this.cursor));
    this.cursor += (rest[0] ?? "").length;
  }

  moveWordLeft(): void {
    const before = this.value.slice(0, this.cursor);
    const m = /(?:\s+\S*|\w+)$/.exec(before);
    this.cursor = m ? Math.max(0, this.cursor - m[0].length) : 0;
  }

  moveWordRight(): void {
    const after = this.value.slice(this.cursor);
    const m = /^(?:\S+\s*)/.exec(after);
    this.cursor = m ? Math.min(this.value.length, this.cursor + m[0].length) : this.value.length;
  }

  deleteWordBack(): void {
    const before = this.cursor;
    this.moveWordLeft();
    this.value = this.value.slice(0, this.cursor) + this.value.slice(before);
  }

  killToLineEnd(): void {
    const nl = this.value.indexOf("\n", this.cursor);
    const end = nl === -1 ? this.value.length : nl;
    this.value = this.value.slice(0, this.cursor) + this.value.slice(end);
  }

  /** Ctrl+U: clear the current logical line (or the whole buffer at line start). */
  killLine(): void {
    if (this.cursor === 0) {
      this.clear();
      return;
    }
    const start = this.value.lastIndexOf("\n", this.cursor - 1) + 1;
    const nl = this.value.indexOf("\n", this.cursor);
    const end = nl === -1 ? this.value.length : nl;
    this.value = this.value.slice(0, start) + this.value.slice(end);
    this.cursor = start;
  }

  lineStart(): void {
    const start = this.value.lastIndexOf("\n", this.cursor - 1) + 1;
    this.cursor = start;
  }

  lineEnd(): void {
    const nl = this.value.indexOf("\n", this.cursor);
    this.cursor = nl === -1 ? this.value.length : nl;
  }

  /** Move the cursor up/down one *visual* line, preserving the column. */
  moveVertical(delta: number, width: number): void {
    const view = this.view(Math.max(1, width));
    const targetRow = view.row + delta;
    if (targetRow < 0) {
      this.lineStart();
      return;
    }
    if (targetRow >= view.lines.length) {
      this.lineEnd();
      return;
    }
    // Convert visual (row, col) to a buffer offset.
    const lineStartOffset = view.lines.slice(0, targetRow).reduce((acc, l) => acc + l.length + 1, 0);
    const lineLength = view.lines[targetRow]!.length;
    this.cursor = Math.min(lineStartOffset + Math.min(view.col, lineLength), this.value.length);
  }

  /** Visual layout for a width. */
  view(width: number): EditorView {
    const w = Math.max(8, width);
    const lines: string[] = [];
    let row = 0;
    let col = 0;
    const logical = this.value.split("\n");
    let offset = 0;
    for (let li = 0; li < logical.length; li++) {
      const line = logical[li]!;
      const chunks: string[] = [];
      if (line.length === 0) chunks.push("");
      else {
        for (let i = 0; i < line.length; i += w) chunks.push(line.slice(i, i + w));
      }
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunkStart = offset + ci * w;
        const chunkEnd = chunkStart + chunks[ci]!.length;
        if (this.cursor >= chunkStart && this.cursor <= chunkEnd) {
          row = lines.length;
          col = this.cursor - chunkStart;
        }
        lines.push(chunks[ci]!);
      }
      offset += line.length + 1;
    }
    if (!lines.length) lines.push("");
    return { lines, row, col, scroll: this.scroll };
  }

  /** Height clamp: keep the cursor's visual row inside the viewport. */
  clampScroll(startRow: number, maxHeight: number): void {
    if (startRow < this.scroll) this.scroll = startRow;
    else if (startRow >= this.scroll + maxHeight) this.scroll = startRow - maxHeight + 1;
  }

  // ---- history ---------------------------------------------------------
  historyPrev(): boolean {
    if (!this.history.length) return false;
    if (this.historyIndex === -1) {
      this.#draft = this.value;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    } else {
      return false;
    }
    this.set(this.history[this.historyIndex] ?? "", (this.history[this.historyIndex] ?? "").length);
    return true;
  }

  historyNext(): boolean {
    if (this.historyIndex === -1) return false;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.set(this.history[this.historyIndex] ?? "");
      return true;
    }
    this.historyIndex = -1;
    this.set(this.#draft);
    return true;
  }

  /** Remember a submitted value (deduplicated, newest last). */
  remember(value: string): void {
    const v = value.trim();
    if (!v) return;
    const last = this.history[this.history.length - 1];
    if (last !== v) this.history.push(v);
    if (this.history.length > 200) this.history.shift();
  }

  /** Prefix of a slash command being typed, when applicable. */
  slashPrefix(): string | null {
    const m = /^\/([a-z-]*)$/i.exec(this.value);
    return m ? m[1]! : null;
  }

  setFromHistory(value: string): void {
    this.set(value);
  }
}
