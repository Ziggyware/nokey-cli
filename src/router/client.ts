/**
 * nokey-router client.
 *
 * OpenAI-compatible surface with the router's extras: routing heartbeats,
 * in-band `kono` telemetry, degraded-mode flags, trace ids and the server-side
 * tool plane. Streaming is incremental and cancellable; retries are surgical
 * (only errors that can actually be retried, with backoff and jitter).
 */
import { SseParser } from "./sse.ts";

export interface RouterOptions {
  baseUrl: string;
  apiKey?: string;
  adminSecret?: string;
  /** Per-request overall timeout. */
  timeoutMs?: number;
  /** Abort when no bytes arrive for this long (the router keeps alive every 15 s). */
  idleMs?: number;
  retries?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  tools?: "auto" | ToolSpec[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  metadata?: Record<string, unknown>;
  /** Router-specific knobs (lane hints, policy). */
  nokey?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Telemetry {
  attempts?: number;
  endpoints?: number;
  degraded?: boolean;
  traceId?: string;
  ttftMs?: number;
  totalMs?: number;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  /** Raw `kono` object from the final chunk. */
  nokey?: Record<string, unknown>;
  finishReason?: string;
  serverTiming?: string;
}

export type ChatEvent =
  | { type: "open"; telemetry: Telemetry }
  | { type: "routing"; message: string }
  | { type: "reasoning"; delta: string }
  | { type: "content"; delta: string }
  | { type: "tool_call"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "usage"; usage: Telemetry["usage"] }
  | { type: "final"; telemetry: Telemetry; finishReason?: string }
  | { type: "degraded"; message: string }
  | { type: "error"; error: RouterError; partial: boolean };

export class RouterError extends Error {
  status: number;
  code: string | undefined;
  retryable: boolean;
  retryAfterMs: number | undefined;
  body: string | undefined;

  constructor(
    message: string,
    opts: { status?: number; code?: string; retryable?: boolean; retryAfterMs?: number; body?: string } = {},
  ) {
    super(message);
    this.name = "RouterError";
    this.status = opts.status ?? 0;
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
    this.body = opts.body;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524]);

function normalizeBase(base: string): string {
  let b = base.trim();
  if (!b) throw new RouterError("No router URL configured", { code: "no_base_url" });
  if (!/^https?:\/\//i.test(b)) b = `https://${b}`;
  return b.replace(/\/+$/, "");
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

export class RouterClient {
  readonly baseUrl: string;
  #apiKey: string | undefined;
  #adminSecret: string | undefined;
  #timeoutMs: number;
  #idleMs: number;
  #retries: number;
  #userAgent: string;
  #fetch: typeof fetch;

  constructor(opts: RouterOptions) {
    this.baseUrl = normalizeBase(opts.baseUrl);
    this.#apiKey = opts.apiKey?.trim() || undefined;
    this.#adminSecret = opts.adminSecret?.trim() || undefined;
    this.#timeoutMs = opts.timeoutMs ?? 180_000;
    this.#idleMs = opts.idleMs ?? 45_000;
    this.#retries = opts.retries ?? 2;
    this.#userAgent = opts.userAgent ?? "kono-cli/1.0 (+https://nokey-router.ziggyware.deno.net)";
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  get hasKey(): boolean {
    return Boolean(this.#apiKey);
  }

  setApiKey(key: string | undefined): void {
    this.#apiKey = key?.trim() || undefined;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      "user-agent": this.#userAgent,
      accept: "application/json",
      ...extra,
    };
    if (this.#apiKey) h.authorization = `Bearer ${this.#apiKey}`;
    if (this.#adminSecret) h["x-admin-secret"] = this.#adminSecret;
    return h;
  }

  url(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  async #request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    let attempt = 0;
    let lastError: RouterError | undefined;
    while (attempt <= this.#retries) {
      const controller = new AbortController();
      const onOuterAbort = () => controller.abort(signal?.reason ?? new Error("aborted"));
      signal?.addEventListener("abort", onOuterAbort, { once: true });
      const timer = setTimeout(() => controller.abort(new RouterError("Request timed out", { code: "timeout", retryable: true })), this.#timeoutMs);
      try {
        const res = await this.#fetch(this.url(path), { ...init, signal: controller.signal });
        if (res.ok) return res;
        const body = await res.text().catch(() => "");
        const retryable = RETRYABLE_STATUS.has(res.status);
        if (retryable && attempt < this.#retries) {
          lastError = new RouterError(httpMessage(res.status, body), {
            status: res.status,
            retryable: true,
            retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
            body,
          });
          const wait = lastError.retryAfterMs ?? jitter(400 * 2 ** attempt);
          await sleep(Math.min(wait, 15_000), signal);
          attempt++;
          continue;
        }
        throw new RouterError(httpMessage(res.status, body), {
          status: res.status,
          retryable,
          code: extractCode(body),
          body,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        const e = err instanceof RouterError ? err : new RouterError(describeNetworkError(err), { retryable: true });
        if (!e.retryable || attempt >= this.#retries) throw e;
        lastError = e;
        await sleep(jitter(400 * 2 ** attempt), signal);
        attempt++;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
      }
    }
    throw lastError ?? new RouterError("Request failed", { retryable: false });
  }

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const res = await this.#request("/health", { headers: this.headers() }, signal);
    return (await res.json()) as Record<string, unknown>;
  }

  async models(signal?: AbortSignal): Promise<ModelCatalog> {
    const res = await this.#request("/v1/models", { headers: this.headers() }, signal);
    return (await res.json()) as ModelCatalog;
  }

  async tools(opts: { flavor?: string; schemas?: boolean; signal?: AbortSignal } = {}): Promise<ToolCatalog> {
    const q = new URLSearchParams();
    if (opts.flavor) q.set("flavor", opts.flavor);
    if (opts.schemas === false) q.set("schemas", "0");
    const res = await this.#request(`/v1/tools${q.size ? `?${q}` : ""}`, { headers: this.headers() }, opts.signal);
    return (await res.json()) as ToolCatalog;
  }

  async executeTools(
    body: { name: string; arguments: unknown } | { calls: Array<{ name: string; arguments: unknown }> },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const res = await this.#request(
      "/v1/tools/execute",
      { method: "POST", headers: this.headers({ "content-type": "application/json" }), body: JSON.stringify(body) },
      signal,
    );
    return (await res.json()) as Record<string, unknown>;
  }

  /** Join a delayed reward to a routing decision (thumbs up/down, regenerate, edit). */
  async feedback(
    body: { traceId?: string; signal?: string; decision?: string; reward?: number; [k: string]: unknown },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    const res = await this.#request(
      "/v1/feedback",
      { method: "POST", headers: this.headers({ "content-type": "application/json" }), body: JSON.stringify(body) },
      signal,
    );
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Non-streaming completion — used for summaries, memory extraction and compaction. */
  async complete(req: ChatRequest, signal?: AbortSignal): Promise<{ text: string; telemetry: Telemetry; finishReason?: string }> {
    const body = JSON.stringify({ ...req, stream: false });
    const res = await this.#request(
      "/v1/chat/completions",
      { method: "POST", headers: this.headers({ "content-type": "application/json", accept: "application/json" }), body },
      signal,
    );
    let raw: string;
    try {
      raw = await res.text();
    } catch (err) {
      throw new RouterError(describeNetworkError(err), { retryable: true });
    }
    // Buffered responses may arrive whitespace-padded while the body is prepared.
    const trimmed = raw.trim();
    if (!trimmed) throw new RouterError("Empty response from router", { status: res.status, code: "empty" });
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      throw new RouterError(`Malformed response: ${trimmed.slice(0, 200)}`, { status: res.status, code: "malformed" });
    }
    const choice = firstChoice(json);
    const text = contentOf(choice);
    return {
      text,
      telemetry: telemetryFromHeaders(res.headers, json),
      finishReason: finishReasonOf(choice),
    };
  }

  /**
   * Stream a chat completion. Yields incremental events; never throws for
   * mid-stream failures — they arrive as `{type:"error", partial:true}` so the
   * UI can keep what it already rendered.
   */
  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent, void, void> {
    const startedAt = Date.now();
    let res: Response;
    try {
      res = await this.#request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: this.headers({
            "content-type": "application/json",
            accept: "text/event-stream, application/json",
            "cache-control": "no-cache",
          }),
          body: JSON.stringify({ ...req, stream: true }),
        },
        signal,
      );
    } catch (err) {
      const e = err instanceof RouterError ? err : new RouterError(describeNetworkError(err), { retryable: true });
      yield { type: "error", error: e, partial: false };
      return;
    }

    const telemetry = telemetryFromHeaders(res.headers, null);
    telemetry.ttftMs = undefined;
    yield { type: "open", telemetry };
    if (telemetry.degraded) {
      yield { type: "degraded", message: "Router is serving a degraded response (all lanes exhausted)." };
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("event-stream") || !res.body) {
      // The router buffered the answer (or an upstream proxy stripped streaming).
      try {
        const json = JSON.parse(await res.text()) as Record<string, unknown>;
        const choice = firstChoice(json);
        const reasoning = reasoningOf(choice);
        if (reasoning) yield { type: "reasoning", delta: reasoning };
        const text = contentOf(choice);
        if (text) yield { type: "content", delta: text };
        const tel = telemetryFromHeaders(res.headers, json);
        tel.ttftMs = tel.ttftMs ?? Date.now() - startedAt;
        tel.totalMs = Date.now() - startedAt;
        yield { type: "final", telemetry: tel, finishReason: finishReasonOf(choice) };
      } catch (err) {
        yield {
          type: "error",
          error: new RouterError(describeNetworkError(err), { status: res.status, retryable: false }),
          partial: false,
        };
      }
      return;
    }

    const parser = new SseParser();
    const reader = res.body.getReader();
    const idle = new AbortController();
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(new RouterError("Stream idle timeout", { code: "idle_timeout", retryable: true })), this.#idleMs);
    };
    armIdle();

    let sawFirstToken = false;
    let finishReason: string | undefined;
    let finalTelemetry: Telemetry | undefined;

    try {
      while (true) {
        let chunk: { done: boolean; value?: Uint8Array };
        const next = reader.read();
        const raced = await Promise.race([
          next.then((r) => ({ kind: "read" as const, r })),
          new Promise<{ kind: "idle" }>((resolve) => {
            const onAbort = () => resolve({ kind: "idle" });
            idle.signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
        if (raced.kind === "idle") {
          await reader.cancel().catch(() => {});
          yield { type: "error", error: new RouterError("Stream idle timeout — no tokens received", { code: "idle_timeout" }), partial: true };
          return;
        }
        chunk = raced.r;
        if (chunk.done || !chunk.value) break;
        // A chunk arrived: disarm the idle watchdog.
        if (idleTimer) clearTimeout(idleTimer);
        const batch = parser.push(chunk.value);
        for (const comment of batch.comments) {
          if (/^trace\b/i.test(comment) || /^routing\b/i.test(comment)) {
            yield { type: "routing", message: comment };
          }
        }
        for (const ev of batch.events) {
          if (ev.data === "[DONE]") {
            finishReason = finishReason ?? "stop";
            continue;
          }
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(ev.data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (payload.error) {
            const errObj = payload.error as Record<string, unknown>;
            yield {
              type: "error",
              error: new RouterError(String(errObj.message ?? "Router error"), {
                code: String(errObj.code ?? errObj.type ?? "upstream_error"),
                retryable: false,
              }),
              partial: true,
            };
            continue;
          }
          if (payload.nokey && typeof payload.nokey === "object") {
            finalTelemetry = { ...(finalTelemetry ?? telemetry), nokey: payload.nokey as Record<string, unknown> };
          }
          const choice = firstChoice(payload);
          if (!choice) continue;
          finishReason = finishReasonOf(choice) ?? finishReason;
          const delta = choice.delta as Record<string, unknown> | undefined;
          if (delta) {
            const reasoning = (delta.reasoning_content ?? delta.reasoning) as string | undefined;
            if (reasoning) {
              if (!sawFirstToken) {
                sawFirstToken = true;
                telemetry.ttftMs = Date.now() - startedAt;
              }
              yield { type: "reasoning", delta: reasoning };
            }
            const content = delta.content as string | undefined;
            if (typeof content === "string" && content.length > 0) {
              if (!sawFirstToken) {
                sawFirstToken = true;
                telemetry.ttftMs = Date.now() - startedAt;
              }
              yield { type: "content", delta: content };
            }
            const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(toolCalls)) {
              for (const call of toolCalls) {
                const fn = (call.function ?? {}) as Record<string, unknown>;
                yield {
                  type: "tool_call",
                  index: Number(call.index ?? 0),
                  id: call.id as string | undefined,
                  name: fn.name as string | undefined,
                  argumentsDelta: fn.arguments as string | undefined,
                };
              }
            }
          }
          if (payload.usage && typeof payload.usage === "object") {
            yield { type: "usage", usage: payload.usage as Telemetry["usage"] };
          }
        }
        armIdle();
      }
      const tail = parser.flush();
      for (const ev of tail.events) {
        if (ev.data === "[DONE]") continue;
        try {
          const payload = JSON.parse(ev.data) as Record<string, unknown>;
          if (payload.nokey && typeof payload.nokey === "object") {
            finalTelemetry = { ...(finalTelemetry ?? telemetry), nokey: payload.nokey as Record<string, unknown> };
          }
        } catch {
          /* ignore */
        }
      }
      const tel: Telemetry = { ...(finalTelemetry ?? telemetry), totalMs: Date.now() - startedAt };
      if (tel.ttftMs === undefined && sawFirstToken) tel.ttftMs = Date.now() - startedAt;
      yield { type: "final", telemetry: tel, finishReason };
    } catch (err) {
      if (signal?.aborted) {
        yield { type: "final", telemetry: { ...telemetry, totalMs: Date.now() - startedAt }, finishReason: "aborted" };
        return;
      }
      yield {
        type: "error",
        error: new RouterError(describeNetworkError(err), { retryable: false }),
        partial: true,
      };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      idle.abort();
      reader.releaseLock?.();
    }
  }
}

function firstChoice(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (!first || typeof first !== "object") return undefined;
  return first as Record<string, unknown>;
}

function contentOf(choice: Record<string, unknown> | undefined): string {
  if (!choice) return "";
  const message = (choice.message ?? choice.delta) as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof (part as { text?: string }).text === "string" ? (part as { text: string }).text : ""))
      .join("");
  }
  return "";
}

function reasoningOf(choice: Record<string, unknown> | undefined): string {
  if (!choice) return "";
  const message = (choice.message ?? choice.delta) as Record<string, unknown> | undefined;
  const r = message?.reasoning_content ?? message?.reasoning;
  return typeof r === "string" ? r : "";
}

function finishReasonOf(choice: Record<string, unknown> | undefined): string | undefined {
  const fr = choice?.finish_reason;
  return typeof fr === "string" ? fr : undefined;
}

export function telemetryFromHeaders(headers: Headers, payload: Record<string, unknown> | null): Telemetry {
  const t: Telemetry = {};
  const attempts = headers.get("x-nokey-attempts");
  if (attempts) t.attempts = Number(attempts);
  const endpoints = headers.get("x-nokey-endpoints");
  if (endpoints) t.endpoints = Number(endpoints);
  if (headers.get("x-nokey-degraded") === "1") t.degraded = true;
  const traceparent = headers.get("traceparent");
  if (traceparent) {
    const parts = traceparent.split("-");
    if (parts.length >= 3) t.traceId = parts[2];
  }
  const serverTiming = headers.get("server-timing");
  if (serverTiming) {
    t.serverTiming = serverTiming;
    const ttft = /ttft;dur=([\d.]+)/.exec(serverTiming);
    if (ttft) t.ttftMs = Math.round(Number(ttft[1]));
    const total = /total;dur=([\d.]+)/.exec(serverTiming);
    if (total) t.totalMs = Math.round(Number(total[1]));
  }
  if (payload) {
    if (payload.model) t.model = String(payload.model);
    if (payload.usage && typeof payload.usage === "object") t.usage = payload.usage as Telemetry["usage"];
    if (payload.nokey && typeof payload.nokey === "object") {
      t.nokey = payload.nokey as Record<string, unknown>;
      // `wire` is the router's own `nokey` object; the name is part of its API.
      const wire = payload.nokey as Record<string, unknown>;
      if (wire.degraded === true) t.degraded = true;
      if (typeof wire.attempts === "number") t.attempts = wire.attempts;
      if (typeof wire.endpoints === "number") t.endpoints = wire.endpoints;
      if (typeof wire.traceId === "string") t.traceId = wire.traceId;
      if (typeof wire.model === "string") t.model = wire.model;
      if (typeof wire.lane === "string" && !t.model) t.model = wire.lane;
      if (wire.usage && typeof wire.usage === "object") t.usage = wire.usage as Telemetry["usage"];
    }
  }
  return t;
}

function httpMessage(status: number, body: string): string {
  let detail = "";
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const err = json.error as Record<string, unknown> | string | undefined;
    if (typeof err === "string") detail = err;
    else if (err && typeof err === "object" && typeof err.message === "string") detail = err.message;
    else if (typeof json.message === "string") detail = json.message;
  } catch {
    detail = body.slice(0, 240).replace(/\s+/g, " ").trim();
  }
  switch (status) {
    case 401:
      return `Unauthorized (401)${detail ? `: ${detail}` : ""}${/key|token|auth/i.test(detail) ? "" : " — check ROUTER_API_KEY"}`;
    case 403:
      return `Forbidden (403)${detail ? `: ${detail}` : ""}`;
    case 404:
      return `Not found (404)${detail ? `: ${detail}` : ""}`;
    case 429:
      return `Rate limited (429)${detail ? `: ${detail}` : " — back off and retry"}`;
    default:
      return `Router error ${status}${detail ? `: ${detail}` : ""}`;
  }
}

function extractCode(body: string): string | undefined {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const err = json.error as Record<string, unknown> | undefined;
    if (err && typeof err.code === "string") return err.code;
    if (typeof json.code === "string") return json.code;
  } catch {
    /* not JSON */
  }
  return undefined;
}

export function describeNetworkError(err: unknown): string {
  if (err instanceof RouterError) return err.message;
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  const cause = e?.cause;
  if (cause?.code === "ENOTFOUND") return "DNS lookup failed — is the router URL reachable?";
  if (cause?.code === "ECONNREFUSED") return "Connection refused — the router is not accepting connections";
  if (cause?.code === "CERT_HAS_EXPIRED") return "TLS certificate expired";
  if (cause?.code === "UND_ERR_CONNECT_TIMEOUT") return "Connection timed out";
  const msg = e?.message ?? String(err);
  if (/aborted/i.test(msg)) return "Request aborted";
  return cause?.message ? `${msg} (${cause.message})` : msg;
}

// ---------------------------------------------------------------------------
// Catalog types (loose: the router's catalogue grows)
// ---------------------------------------------------------------------------

export interface CatalogModel {
  id: string;
  object?: string;
  owned_by?: string;
  provider?: string;
  iq?: number;
  context_length?: number;
  contextLength?: number;
  capabilities?: string[] | Record<string, unknown>;
  lane?: string;
  kind?: string;
  [key: string]: unknown;
}

export interface ModelCatalog {
  object?: string;
  data?: CatalogModel[];
  aliases?: string[] | Record<string, unknown>;
  models?: CatalogModel[];
  image_models?: string[];
  [key: string]: unknown;
}

export interface ToolCatalog {
  object?: string;
  data?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  wire?: unknown;
  [key: string]: unknown;
}

export function catalogModels(catalog: ModelCatalog | null): CatalogModel[] {
  if (!catalog) return [];
  const list = catalog.data ?? catalog.models ?? [];
  return Array.isArray(list) ? list.filter((m): m is CatalogModel => Boolean(m) && typeof m === "object" && typeof (m as CatalogModel).id === "string") : [];
}

export function catalogAliases(catalog: ModelCatalog | null): string[] {
  if (!catalog) return [];
  const aliases = catalog.aliases;
  if (Array.isArray(aliases)) return aliases.filter((a): a is string => typeof a === "string");
  if (aliases && typeof aliases === "object") return Object.keys(aliases);
  const models = catalogModels(catalog);
  return models.map((m) => m.id).filter((id) => id.includes(":"));
}
