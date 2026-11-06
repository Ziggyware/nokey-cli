/**
 * Context assembly and compaction.
 *
 * Turns the session DAG into a request: system prompt (persona + project docs +
 * retrieved memory), then history ending at the active leaf. Compaction
 * summaries live *in* the tree as `summary` nodes, so the context builder
 * simply resets its window at the most recent summary — branches inherit the
 * summary naturally and no hidden state is needed.
 */
import { readFileSync, existsSync } from "node:fs";
import type { ChatMessage } from "../router/client.ts";
import type { Config } from "../store/config.ts";
import type { Message, Session } from "../store/session.ts";
import type { MemoryItem } from "../store/memory.ts";
import { MemoryBank } from "../store/memory.ts";
import { projectDocs } from "../store/paths.ts";
import { estimateMessages, estimateTokens } from "../util/tokens.ts";

export interface ContextStats {
  systemTokens: number;
  memoryTokens: number;
  historyTokens: number;
  totalTokens: number;
  windowTokens: number;
  budgetTokens: number;
  utilization: number;
  messageCount: number;
  droppedMessages: number;
  memoryItems: number;
}

export interface ContextPlan {
  system: string;
  messages: ChatMessage[];
  stats: ContextStats;
  memory: MemoryItem[];
  memoryBlock: string;
  /** True when history exceeds the compaction threshold. */
  needsCompaction: boolean;
  /** Messages eligible to be summarized (oldest first, excludes kept tail). */
  compactable: Message[];
  /** Messages the plan wants to keep verbatim. */
  keep: Message[];
  /** Messages summarised earlier in this path (their summaries are in `messages`). */
  priorSummaries: Message[];
}

export interface BuildContextInput {
  session: Session;
  config: Config;
  memory?: MemoryItem[];
  memoryBlock?: string;
  /** Overrides config.context.windowTokens when the catalogue knows better. */
  windowTokens?: number;
  cwd?: string;
  /** Optional extra system instruction for one turn. */
  extraSystem?: string;
  now?: number;
}

const MAX_PROJECT_DOC_CHARS = 8_000;

/** Read project instruction files once per call; small and cheap. */
export function readProjectInstructions(cwd = process.cwd(), maxChars = MAX_PROJECT_DOC_CHARS): string {
  const chunks: string[] = [];
  let used = 0;
  for (const path of projectDocs(cwd)) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf8").trim();
      if (!raw) continue;
      const slice = raw.slice(0, Math.max(0, maxChars - used));
      if (!slice) break;
      chunks.push(`### ${path}\n${slice}`);
      used += slice.length;
      if (used >= maxChars) break;
    } catch {
      /* unreadable file — skip */
    }
  }
  return chunks.join("\n\n").slice(0, Math.max(0, maxChars));
}

export function defaultPersona(): string {
  return [
    "You are a precise, friendly engineering assistant running inside nokey-cli, a terminal chat client for the nokey-router.",
    "Format answers for a terminal: short paragraphs, fenced code blocks with a language tag, tables when comparing.",
    "Prefer concrete, runnable answers over prose. Never invent APIs or files that do not exist.",
  ].join("\n");
}

export function memoryBlockFor(items: MemoryItem[]): string {
  const block = MemoryBank.formatBlock(items);
  if (!block) return "";
  return `Known memory (durable facts from earlier sessions — use them, do not restate them verbatim):\n${block}`;
}

function runtimeLine(model: string, now: number, cwd?: string): string {
  const date = new Date(now).toISOString().slice(0, 10);
  return `Today is ${date}. Model lane: ${model}.${cwd ? ` Working directory: ${cwd}.` : ""}`;
}

/**
 * Map one stored message to the wire format.
 * Reasoning is deliberately not sent back — it is display-only.
 */
export function toWireMessage(msg: Message): ChatMessage | null {
  switch (msg.role) {
    case "user":
      return { role: "user", content: msg.content };
    case "assistant": {
      const wire: ChatMessage = { role: "assistant", content: msg.content || "" };
      if (msg.toolCalls?.length) {
        wire.tool_calls = msg.toolCalls.map((call, i) => ({
          id: call.id ?? `call_${msg.id}_${i}`,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      return wire;
    }
    case "tool":
      return { role: "tool", content: msg.content, tool_call_id: msg.toolCallId ?? msg.id, name: msg.toolName };
    case "summary":
      return { role: "system", content: `Summary of the earlier conversation:\n${msg.content}` };
    case "system":
      return msg.systemKind === "persona" ? null : { role: "system", content: msg.content };
  }
}

/** Walk the active path and split it at the newest compaction summary. */
export function conversationWindow(session: Session): { messages: Message[]; summaries: Message[] } {
  const path = session.path();
  let start = 0;
  const summaries: Message[] = [];
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i]!.role === "summary") {
      start = i;
      summaries.push(path[i]!);
      break;
    }
  }
  return { messages: path.slice(start), summaries };
}

export function buildContext(input: BuildContextInput): ContextPlan {
  const { session, config } = input;
  const now = input.now ?? Date.now();
  const windowTokens = input.windowTokens ?? config.context.windowTokens;
  const budget = Math.max(1_000, windowTokens - config.context.reserveOutputTokens);

  const persona = (session.meta.systemPrompt?.trim() || defaultPersona()).trim();
  const parts = [persona];
  if (config.memory.readProjectDocs) {
    const docs = readProjectInstructions(input.cwd);
    if (docs) parts.push(`Project instructions from the working directory:\n${docs}`);
  }
  const memoryBlock = input.memoryBlock ?? memoryBlockFor(input.memory ?? []);
  if (memoryBlock) parts.push(memoryBlock);
  if (input.extraSystem) parts.push(input.extraSystem.trim());
  parts.push(runtimeLine(session.meta.model, now, input.cwd));
  const system = parts.filter(Boolean).join("\n\n");

  const systemTokens = estimateTokens(system);
  const memoryTokens = memoryBlock ? estimateTokens(memoryBlock) : 0;
  const { messages: window } = conversationWindow(session);

  const wire: ChatMessage[] = [];
  const included: Message[] = [];
  for (const msg of window) {
    const converted = toWireMessage(msg);
    if (!converted) continue;
    if (!converted.content && !converted.tool_calls) continue;
    wire.push(converted);
    included.push(msg);
  }

  let historyTokens = estimateMessages(wire);
  let dropped = 0;
  const threshold = budget * config.context.compactAt;
  let needsCompaction = historyTokens + systemTokens > threshold && config.context.compaction === "auto";

  // Hard ceiling: never send a request that cannot fit. Evict the oldest
  // *unpinned* message first, always keeping the tail — pins survive because
  // they are what the user explicitly asked to keep in view.
  const effective = [...included];
  while (historyTokens + systemTokens > budget && effective.length > 2) {
    const victim = effective.findIndex((m, i) => !m.pinned && m.role !== "summary" && i < effective.length - 2);
    if (victim === -1) break;
    effective.splice(victim, 1);
    dropped++;
    historyTokens = estimateMessages(
      effective.map(toWireMessage).filter((m): m is ChatMessage => m !== null && Boolean(m.content || m.tool_calls)),
    );
  }
  const wireFinal = effective.map(toWireMessage).filter((m): m is ChatMessage => m !== null && Boolean(m.content || m.tool_calls));

  // What compaction would fold away: everything before the kept tail.
  const keepCount = Math.max(2, config.context.keepRecent);
  const cutoff = Math.max(0, effective.length - keepCount);
  const compactable = effective.slice(0, cutoff).filter((m) => !m.pinned && m.role !== "summary");
  const keep = effective.slice(cutoff);

  const totalTokens = systemTokens + estimateMessages(wireFinal);
  const stats: ContextStats = {
    systemTokens,
    memoryTokens,
    historyTokens: totalTokens - systemTokens,
    totalTokens,
    windowTokens,
    budgetTokens: budget,
    utilization: Math.min(1, totalTokens / Math.max(1, windowTokens)),
    messageCount: wireFinal.length,
    droppedMessages: dropped,
    memoryItems: input.memory?.length ?? 0,
  };

  if (config.context.compaction !== "auto") needsCompaction = false;

  return {
    system,
    messages: wireFinal,
    stats,
    memory: input.memory ?? [],
    memoryBlock,
    needsCompaction,
    compactable,
    keep,
    priorSummaries: window.filter((m) => m.role === "summary"),
  };
}

export const SUMMARIZER_PROMPT = `You compress a conversation into a briefing that another assistant will use to continue the work.
Write plain markdown, at most ~350 words, with these sections (omit an empty section):
## Goal
## Decisions
## Facts & constraints
## Current state
## Open questions
Preserve exact identifiers (file paths, commands, model names, numbers). Do not invent anything. No preamble.`;

/** Build the summarization request payload. */
export function summarizationRequest(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "summary") continue;
    const who = m.role === "user" ? "USER" : m.role === "assistant" ? "ASSISTANT" : m.role.toUpperCase();
    const body = (m.content || "").slice(0, 4_000);
    lines.push(`${who}: ${body}`);
  }
  return lines.join("\n\n").slice(0, 60_000);
}

/** Offline fallback when the summarizer call fails: structural digest. */
export function fallbackSummary(messages: Message[]): string {
  const userTurns = messages.filter((m) => m.role === "user");
  const assistantTurns = messages.filter((m) => m.role === "assistant" && m.content);
  const head = userTurns.slice(0, 3).map((m) => `- ${firstLine(m.content, 140)}`);
  const tail = userTurns.slice(-3).map((m) => `- ${firstLine(m.content, 140)}`);
  const lastAnswer = assistantTurns.at(-1);
  const out = ["## Goal", ...(head.length ? head : ["- (no user turns recorded)"])];
  if (userTurns.length > 6) out.push("", "## Later requests", ...tail);
  if (lastAnswer) out.push("", "## Current state", firstLine(lastAnswer.content, 400));
  out.push("", `_(${messages.length} earlier messages condensed locally; summarizer unavailable.)_`);
  return out.join("\n");
}

function firstLine(text: string, max: boolean | number = 140): string {
  const limit = typeof max === "number" ? max : 140;
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

/** Rough context window for well-known model families (conservative). */
export function knownWindow(model: string): number | undefined {
  const m = model.toLowerCase();
  if (/\b(1m|1000000)\b/.test(m)) return 1_000_000;
  if (/(claude|sonnet|opus|haiku)/.test(m)) return 200_000;
  if (/(gpt-4\.1|gpt-5|o3|o4)/.test(m)) return 200_000;
  if (/(gemini|flash|pro)/.test(m)) return 1_000_000;
  if (/(llama|qwen|deepseek|mistral|mixtral|gemma|phi)/.test(m)) return 128_000;
  if (/free:/.test(m)) return undefined;
  return undefined;
}
