/**
 * Server-Sent Events parser.
 *
 * Handles the frames nokey-router actually sends: `data:` payloads, `: routing`
 * and `: keepalive` heartbeats, `: trace` comments, CRLF or LF, and frames
 * split arbitrarily across TCP chunks mid-UTF8.
 */
export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export interface SseBatch {
  events: SseEvent[];
  /** Comment lines (heartbeats, routing notices) in order. */
  comments: string[];
}

export class SseParser {
  #buffer = "";
  #decoder = new TextDecoder("utf-8", { fatal: false });
  #data: string[] = [];
  #event: string | undefined;
  #id: string | undefined;
  #sawFirstChunk = false;

  /** Feed bytes or text; returns whatever completed in this chunk. */
  push(chunk: Uint8Array | string): SseBatch {
    let text: string;
    if (typeof chunk === "string") text = chunk;
    else {
      if (!this.#sawFirstChunk) {
        this.#sawFirstChunk = true;
        text = this.#decoder.decode(chunk, { stream: true });
      } else text = this.#decoder.decode(chunk, { stream: true });
    }
    if (!text) return { events: [], comments: [] };
    this.#buffer += text;
    // Strip a UTF-8 BOM if it leads the stream.
    if (this.#buffer.startsWith("\ufeff")) this.#buffer = this.#buffer.slice(1);

    const events: SseEvent[] = [];
    const comments: string[] = [];

    let index: number;
    // Consume complete lines, keeping any partial trailing line buffered.
    while ((index = this.#buffer.search(/\r\n|\r|\n/)) !== -1) {
      const newlineLen = this.#buffer.startsWith("\r\n", index) ? 2 : 1;
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + newlineLen);
      if (line === "") {
        if (this.#data.length) {
          const ev: SseEvent = { data: this.#data.join("\n") };
          if (this.#event !== undefined) ev.event = this.#event;
          if (this.#id !== undefined) ev.id = this.#id;
          events.push(ev);
        }
        this.#data = [];
        this.#event = undefined;
        continue;
      }
      if (line.startsWith(":")) {
        comments.push(line.slice(1).trim());
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      switch (field) {
        case "data":
          this.#data.push(value);
          break;
        case "event":
          this.#event = value;
          break;
        case "id":
          this.#id = value;
          break;
        case "retry":
          break;
        default:
          break;
      }
    }
    return { events, comments };
  }

  /** Flush a final event if the stream ended without a blank line. */
  flush(): SseBatch {
    const events: SseEvent[] = [];
    if (this.#data.length) {
      events.push({ data: this.#data.join("\n"), ...(this.#event ? { event: this.#event } : {}) });
      this.#data = [];
      this.#event = undefined;
    }
    return { events, comments: [] };
  }
}
