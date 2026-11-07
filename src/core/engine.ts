/**
 * The turn engine.
 *
 * One place that knows how a prompt becomes a persisted, streamed, remembered
 * turn: retrieve memory → compact if needed → stream → checkpoint → extract
 * memory → emit telemetry. The UI only renders events; the CLI print mode does
 * the same. That keeps behaviour identical everywhere.
 */
import type { ChatMessage, Telemetry, ToolSpec } from "../router/client.ts";
import { describeNetworkError, RouterClient, RouterError } from "../router/client.ts";
import type { Config } from "../store/config.ts";
import type { Message, Session, ToolCallRecord } from "../store/session.ts";
import type { MemoryItem, MemoryStack } from "../store/memory.ts";
import type { MemoryBank } from "../store/memory.ts";
import { buildContext, fallbackSummary, knownWindow, SUMMARIZER_PROMPT, summarizationRequest } from "./context.ts";
import type { ContextStats } from "./context.ts";
import { contradictions, extractHeuristic, extractWithModel, novel } from "./memory-extract.ts";
import type { Extracted } from "./memory-extract.ts";
import { deriveTitle } from "../store/session.ts";
import { estimateTokens } from "../util/tokens.ts";

export type EngineEvent =
  | { type: "start"; message: Message }
  | { type: "context"; stats: ContextStats; memory: MemoryItem[]; window: number }
  | { type: "compacting"; count: number }
  | {
      type: "compacted";
      summary: Message;
      count: number;
      /** How the summary was produced. */
      via: "model" | "fallback";
    }
  | { type: "routing"; message: string }
  | { type: "reasoning"; delta: string }
  | { type: "delta"; delta: string }
  | { type: "tool"; call: ToolCallRecord }
  | { type: "checkpoint"; message: Message }
  | { type: "telemetry"; telemetry: Telemetry }
  | { type: "done"; message: Message; stats: ContextStats }
  | { type: "error"; error: RouterError; partial?: Message; retryable: boolean }
  | { type: "memory"; added: MemoryItem[]; candidates: number }
  | { type: "title"; title: string };

export interface EngineDeps {
  session: Session;
  router: RouterClient;
  config: Config;
  /** Global + project + session banks, already ordered by priority. */
  memory: MemoryStack;
  /** Bank new automatic memories are written to. */
  autoBank: MemoryBank;
  sessionBank?: MemoryBank;
  cwd?: string;
}

export interface SendOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: boolean;
  /** Extra system instruction for this turn only (e.g. a slash-command hint). */
  extraSystem?: string;
  /** Skip memory retrieval (used by utility calls). */
  noMemory?: boolean;
  /** Do not append a user message (regeneration path). */
  skipUserMessage?: boolean;
  userText?: string;
}

export class TurnEngine {
  readonly deps: EngineDeps;
  #controller: AbortController | null = null;
  #busy = false;

  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  get busy(): boolean {
    return this.#busy;
  }

  get session(): Session {
    return this.deps.session;
  }

  get config(): Config {
    return this.deps.config;
  }

  abort(): void {
    this.#controller?.abort(new Error("aborted by user"));
    this.#controller = null;
  }

  /** Effective context window for the active model. */
  #window(model: string): number {
    return knownWindow(model) ?? this.config.context.windowTokens;
  }

  /**
   * Append the user turn, stream the answer, persist it and learn from it.
   */
  async *send(userText: string, opts: SendOptions = {}): AsyncGenerator<EngineEvent, void, void> {
    if (this.#busy) {
      yield { type: "error", error: new RouterError("A turn is already in flight", { code: "busy" }), retryable: false };
      return;
    }
    this.#busy = true;
    const controller = new AbortController();
    this.#controller = controller;
    try {
      const { session, config, router } = this.deps;
      const model = opts.model ?? session.meta.model;
      if (model !== session.meta.model) session.patchMeta({ model });

      if (!opts.skipUserMessage) {
        const text = userText.trim();
        if (!text) {
          yield { type: "error", error: new RouterError("Empty prompt", { code: "empty_prompt" }), retryable: false };
          return;
        }
        session.add({
          role: "user",
          content: text,
          parentId: session.leafId,
        });
        if (config.session.titleSource === "first-message") session.autotitle();
      }

      // ---- context ------------------------------------------------------
      const query = `${userText}\n${session.path().slice(-2).map((m) => m.content).join("\n")}`;
      let memoryItems: MemoryItem[] = [];
      if (config.memory.enabled && !opts.noMemory) {
        memoryItems = this.deps.memory.retrieve(query, {
          topK: config.memory.injectTopK,
          tokenBudget: config.memory.injectTokens,
        });
      }
      const window = this.#window(model);
      let plan = buildContext({
        session,
        config,
        memory: memoryItems,
        windowTokens: window,
        cwd: this.deps.cwd,
        ...(opts.extraSystem ? { extraSystem: opts.extraSystem } : {}),
      });
      yield { type: "context", stats: plan.stats, memory: memoryItems, window };

      // ---- compaction ---------------------------------------------------
      if (plan.needsCompaction && plan.compactable.length >= 4) {
        yield { type: "compacting", count: plan.compactable.length };
        const compacted = await this.#compact(plan.compactable, controller.signal);
        if (compacted) {
          yield { type: "compacted", summary: compacted.message, count: plan.compactable.length, via: compacted.via };
          plan = buildContext({
            session,
            config,
            memory: memoryItems,
            windowTokens: window,
            cwd: this.deps.cwd,
            ...(opts.extraSystem ? { extraSystem: opts.extraSystem } : {}),
          });
          yield { type: "context", stats: plan.stats, memory: memoryItems, window };
        }
      }

      // Memory that contributed to this turn is marked used, which feeds the
      // recency score next time.
      if (memoryItems.length) this.deps.memory.touch(memoryItems);

      // ---- request ------------------------------------------------------
      const wire: ChatMessage[] = [{ role: "system", content: plan.system }, ...plan.messages];
      const assistant = session.add({
        role: "assistant",
        content: "",
        parentId: session.leafId,
        model,
        lane: laneOf(model),
        ...(memoryItems.length ? { memoryRefs: memoryItems.map((m) => m.id) } : {}),
      });

      // Announce the node immediately so the UI can bind its live buffer to it.
      yield { type: "start", message: assistant };

      let content = "";
      let reasoning = "";
      let telemetry: Telemetry = {};
      const toolCalls = new Map<number, ToolCallRecord>();
      let lastCheckpoint = Date.now();
      let failure: RouterError | null = null;

      const requestTools = opts.tools ?? config.tools.auto;
      for await (const ev of router.stream(
        {
          model,
          messages: wire,
          ...(config.model.temperature !== null && opts.temperature === undefined ? { temperature: config.model.temperature } : {}),
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(config.model.maxTokens !== null && opts.maxTokens === undefined ? { max_tokens: config.model.maxTokens } : {}),
          ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
          ...(requestTools ? { tools: "auto" as const } : {}),
        },
        controller.signal,
      )) {
        switch (ev.type) {
          case "open":
            telemetry = { ...telemetry, ...ev.telemetry };
            yield { type: "telemetry", telemetry };
            break;
          case "degraded":
            yield { type: "routing", message: ev.message };
            break;
          case "routing":
            yield { type: "routing", message: ev.message };
            break;
          case "reasoning":
            reasoning += ev.delta;
            yield { type: "reasoning", delta: ev.delta };
            break;
          case "content":
            content += ev.delta;
            yield { type: "delta", delta: ev.delta };
            break;
          case "tool_call": {
            const existing = toolCalls.get(ev.index) ?? { name: "", arguments: "", id: ev.id };
            if (ev.name) existing.name = ev.name;
            if (ev.id) existing.id = ev.id;
            if (ev.argumentsDelta) existing.arguments += ev.argumentsDelta;
            toolCalls.set(ev.index, existing);
            yield { type: "tool", call: existing };
            break;
          }
          case "usage":
            telemetry = { ...telemetry, usage: ev.usage };
            break;
          case "final": {
            telemetry = { ...telemetry, ...ev.telemetry };
            if (ev.finishReason) telemetry.finishReason = ev.finishReason;
            yield { type: "telemetry", telemetry };
            break;
          }
          case "error":
            failure = ev.error;
            break;
        }

        // Crash-safe checkpoints: a long answer survives a kill.
        if (Date.now() - lastCheckpoint > 2_000) {
          lastCheckpoint = Date.now();
          const saved = session.update(assistant.id, {
            content,
            ...(reasoning ? { reasoning } : {}),
            toolCalls: [...toolCalls.values()],
          });
          if (saved) yield { type: "checkpoint", message: saved };
        }
      }

      // ---- finalise -----------------------------------------------------
      const usage = telemetry.usage;
      const promptTokens = usage?.prompt_tokens ?? plan.stats.totalTokens;
      const completionTokens = usage?.completion_tokens ?? estimateTokens(content + reasoning);
      const totalMs = telemetry.totalMs;
      const tokensPerSec = totalMs && completionTokens ? completionTokens / (totalMs / 1000) : undefined;

      const patch: Partial<Message> = {
        content,
        ...(reasoning ? { reasoning } : {}),
        telemetry: {
          ...(telemetry.attempts !== undefined ? { attempts: telemetry.attempts } : {}),
          ...(telemetry.endpoints !== undefined ? { endpoints: telemetry.endpoints } : {}),
          ...(telemetry.degraded ? { degraded: true } : {}),
          ...(telemetry.traceId ? { traceId: telemetry.traceId } : {}),
          ...(telemetry.ttftMs !== undefined ? { ttftMs: telemetry.ttftMs } : {}),
          ...(totalMs !== undefined ? { totalMs } : {}),
          ...(telemetry.model ? { model: telemetry.model } : {}),
          lane: laneOf(model),
          promptTokens,
          completionTokens,
          ...(tokensPerSec ? { tokensPerSec } : {}),
          ...(telemetry.finishReason ? { finishReason: telemetry.finishReason } : {}),
        },
      };
      if (toolCalls.size) patch.toolCalls = [...toolCalls.values()];
      if (failure) patch.error = failure.message;

      if (!content && !reasoning && failure) {
        // Nothing arrived: keep the failed turn visible but clearly empty.
        patch.content = "";
        patch.error = failure.message;
      }

      const saved = session.update(assistant.id, patch) ?? assistant;
      session.saveMeta();

      if (failure) {
        yield {
          type: "error",
          error: failure,
          partial: saved,
          retryable: failure.retryable || failure.code === "idle_timeout" || failure.code === "timeout",
        };
      } else {
        yield { type: "done", message: saved, stats: plan.stats };
      }

      // ---- learn --------------------------------------------------------
      const learned = this.#learn(userText, content, saved);
      if (learned.added.length) yield { type: "memory", added: learned.added, candidates: learned.candidates };

      if (config.session.titleSource === "auto" && isPlaceholderTitle(session.meta.title)) {
        const title = await this.#generateTitle(userText, content, controller.signal);
        if (title) yield { type: "title", title };
      }
    } finally {
      this.#busy = false;
      if (this.#controller === controller) this.#controller = null;
    }
  }

  /**
   * Regenerate the last assistant answer as a sibling branch (nothing is lost).
   */
  async *retry(opts: SendOptions = {}): AsyncGenerator<EngineEvent, void, void> {
    const { session } = this.deps;
    const lastAssistant = session.last("assistant");
    const path = session.path();
    let parentId: string | null = null;
    if (lastAssistant) {
      const idx = path.findIndex((m) => m.id === lastAssistant.id);
      parentId = idx > 0 ? (path[idx - 1]?.id ?? null) : lastAssistant.parentId;
    }
    if (!parentId) {
      yield {
        type: "error",
        error: new RouterError("Nothing to regenerate — send a prompt first", { code: "nothing_to_retry" }),
        retryable: false,
      };
      return;
    }
    session.setLeaf(parentId);
    const lastUser = [...session.path()].reverse().find((m) => m.role === "user");
    yield* this.send(lastUser?.content ?? "", { ...opts, skipUserMessage: true, userText: lastUser?.content ?? "" });
  }

  /** Summarize a slice of history into a summary node in the tree. */
  async #compact(messages: Message[], signal: AbortSignal): Promise<{ message: Message; via: "model" | "fallback" } | null> {
    const { session, config, router } = this.deps;
    if (!messages.length) return null;
    const payload = summarizationRequest(messages);
    let summaryText = "";
    let via: "model" | "fallback" = "fallback";
    try {
      const { text } = await router.complete(
        {
          model: config.context.summarizerModel || config.model.fast,
          messages: [
            { role: "system", content: SUMMARIZER_PROMPT },
            { role: "user", content: payload },
          ],
          temperature: 0.2,
          max_tokens: 700,
        },
        signal,
      );
      if (text.trim().length > 40) {
        summaryText = text.trim();
        via = "model";
      }
    } catch {
      // Offline, rate-limited, or the lane is dead — keep going with a digest.
    }
    if (!summaryText) summaryText = fallbackSummary(messages);

    const leaf = session.leafId;
    const summary = session.add({
      role: "summary",
      content: summaryText,
      parentId: leaf,
      systemKind: "compaction",
      summaryOf: messages.map((m) => m.id),
      model: config.context.summarizerModel,
    });
    session.recordCompaction(summary.id, messages.map((m) => m.id));
    return { message: summary, via };
  }

  /** Explicit `/compact` from the UI. */
  async compactNow(signal?: AbortSignal): Promise<{ message: Message; via: string; count: number } | null> {
    const plan = buildContext({
      session: this.deps.session,
      config: this.config,
      windowTokens: this.#window(this.deps.session.meta.model),
      cwd: this.deps.cwd,
    });
    const candidates = plan.compactable.length >= 2 ? plan.compactable : plan.keep.slice(0, Math.max(0, plan.keep.length - 2));
    if (!candidates.length) return null;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await this.#compact(candidates, controller.signal);
      return result ? { message: result.message, via: result.via, count: candidates.length } : null;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Store heuristically or model-extracted memories; never throws. */
  #learn(userText: string, assistantText: string, message: Message): { added: MemoryItem[]; candidates: number } {
    const { config } = this.deps;
    if (!config.memory.enabled || config.memory.extract === "off") return { added: [], candidates: 0 };
    const bank = this.deps.autoBank;
    const existing = this.deps.memory.all();
    const extracted: Extracted[] = [];
    if (config.memory.extract === "heuristic" || config.memory.extract === "llm") {
      extracted.push(...extractHeuristic(userText, "user"));
      if (config.memory.extract === "heuristic") extracted.push(...extractHeuristic(assistantText, "assistant"));
    }
    const fresh = novel(extracted.filter((e) => e.confidence >= 0.6), existing);
    const added: MemoryItem[] = [];
    for (const candidate of fresh.slice(0, 4)) {
      // A contradiction supersedes the old item instead of leaving both.
      for (const old of contradictions(candidate, existing)) {
        bank.update(old.id, { supersededBy: `pending:${candidate.text.slice(0, 24)}` });
      }
      const { item, action } = bank.add(candidate.text, {
        kind: candidate.kind,
        source: { sessionId: this.session.id, messageId: message.id, kind: "user" },
      });
      if (action === "added") added.push(item);
    }
    bank.prune(config.memory.maxItems);
    return { added, candidates: fresh.length };
  }

  /** Background LLM extraction — used by `/remember --smart` and llm mode. */
  async extractWithModel(userText: string, assistantText: string): Promise<MemoryItem[]> {
    const { config, router } = this.deps;
    const items = await extractWithModel(
      router,
      config.memory.extractorModel,
      { user: userText, assistant: assistantText },
      undefined,
    );
    const existing = this.deps.memory.all();
    const added: MemoryItem[] = [];
    for (const candidate of novel(items, existing).slice(0, 6)) {
      const { item, action } = this.deps.autoBank.add(candidate.text, {
        kind: candidate.kind,
        source: { sessionId: this.session.id, kind: "user" },
      });
      if (action === "added") added.push(item);
    }
    return added;
  }

  async #generateTitle(userText: string, assistantText: string, signal: AbortSignal): Promise<string | null> {
    const { config, router, session } = this.deps;
    try {
      const { text } = await router.complete(
        {
          model: config.model.fast || config.model.default,
          messages: [
            {
              role: "system",
              content: "Reply with a 3-6 word title for this conversation. No quotes, no trailing punctuation, no preamble.",
            },
            { role: "user", content: `USER: ${userText.slice(0, 1200)}\n\nASSISTANT: ${assistantText.slice(0, 800)}` },
          ],
          temperature: 0.3,
          max_tokens: 32,
        },
        signal,
      );
      const title = text
        .replace(/^["'#\s-]+|["'.\s]+$/g, "")
        .split("\n")[0]!
        .slice(0, 64)
        .trim();
      if (!title) return null;
      session.rename(title);
      return title;
    } catch {
      const title = deriveTitle(userText);
      session.rename(title);
      return title;
    }
  }
}

function isPlaceholderTitle(title: string): boolean {
  return !title || title === "New session" || title === "Untitled session";
}

export function laneOf(model: string): string {
  const m = model.toLowerCase();
  if (m.includes(":")) return model;
  if (/(reason|think|o3|o4|r1)/.test(m)) return "reasoning";
  if (/(code|coder|devstral)/.test(m)) return "code";
  if (/(flash|mini|small|haiku|fast)/.test(m)) return "fast";
  return "auto";
}

/** Friendly summary for the UI when a request fails. */
export function explainError(error: unknown): { message: string; hint?: string } {
  if (error instanceof RouterError) {
    if (error.status === 401) {
      return {
        message: error.message,
        hint: "Set your key with /key <ROUTER_API_KEY> or export KONO_API_KEY=…",
      };
    }
    if (error.status === 429) {
      return { message: error.message, hint: "Wait for Retry-After, or switch lane with /model free:fast" };
    }
    if (error.code === "idle_timeout") {
      return { message: error.message, hint: "The router heartbeats every 15 s; a long silence usually means a dead endpoint. /retry" };
    }
    return { message: error.message };
  }
  return { message: describeNetworkError(error) };
}

export { estimateTokens, buildContext };
export type { ContextStats, ToolSpec };
