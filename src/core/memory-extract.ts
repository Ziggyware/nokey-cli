/**
 * Memory extraction.
 *
 * Heuristic mode is deterministic and offline: sentence-level patterns that
 * catch the things people actually repeat to an assistant (preferences,
 * decisions, constraints, open tasks, identity). LLM mode asks a cheap lane for
 * strict JSON and then runs the *same* validation and de-duplication, so a bad
 * model can waste a request but cannot corrupt the bank.
 */
import type { RouterClient } from "../router/client.ts";
import type { MemoryKind, MemoryItem } from "../store/memory.ts";
import { jaccard, tokenize } from "../store/memory.ts";

export interface Extracted {
  text: string;
  kind: MemoryKind;
  confidence: number;
}

interface Rule {
  kind: MemoryKind;
  re: RegExp;
  confidence: number;
  /** Capture group holding the useful sentence. */
  group?: number;
}

const RULES: Rule[] = [
  { kind: "entity", re: /\b(?:my name is|i'?m called|call me)\s+([A-Z][\w'’-]{1,30}(?:\s+[A-Z][\w'’-]{1,30})?)/i, confidence: 0.85, group: 1 },
  { kind: "preference", re: /\b(?:i (?:really |strongly )?(?:prefer|like|love|hate|dislike|want|need|avoid)|i'?d rather|i would rather|my preference is)\b[^.!?\n]{2,160}/i, confidence: 0.8 },
  { kind: "preference", re: /\b(?:please\s+)?(?:always|never)\s+(?:use|do|add|write|include|avoid|check)\b[^.!?\n]{2,160}/i, confidence: 0.75 },
  { kind: "preference", re: /\b(?:use|prefer)\s+[\w.+-]+\s+(?:instead of|over|rather than)\s+[\w.+-]+/i, confidence: 0.75 },
  { kind: "decision", re: /\b(?:we|i|team)\s+(?:have\s+)?(?:decided|agreed|chose|settled on|went with)\b[^.!?\n]{2,160}/i, confidence: 0.8 },
  { kind: "decision", re: /\b(?:decision|we'?ll go with|going with|let'?s go with)\s*[:\-]\s*[^.!?\n]{2,160}/i, confidence: 0.75 },
  { kind: "fact", re: /\b(?:we|i|the team|the project|this (?:repo|project|codebase))\s+(?:use|uses|runs|deploys|targets|builds with|is built with)\b[^.!?\n]{2,160}/i, confidence: 0.65 },
  { kind: "fact", re: /\b(?:my (?:role|team|company|timezone|os|editor|shell)|i work (?:at|on|with))\b[^.!?\n]{2,160}/i, confidence: 0.7 },
  { kind: "task", re: /\b(?:todo|to-do|next step|remember to|don'?t forget to|still need to|i need to|we need to|let'?s)\b[^.!?\n]{2,160}/i, confidence: 0.6 },
  { kind: "note", re: /\b(?:remember|keep in mind|note that|important:)\b[^.!?\n]{2,200}/i, confidence: 0.7 },
  { kind: "fact", re: /\b(?:the (?:api|endpoint|url|port|database|schema|model))\s+(?:is|uses|lives at|runs on)\b[^.!?\n]{2,160}/i, confidence: 0.55 },
];

const NOISE = /^(?:yes|no|ok|okay|sure|thanks|thank you|got it|cool|great|nice)\b/i;

function splitSentences(text: string): string[] {
  const stripped = text.replace(/```[\s\S]*?```/g, " ");
  return stripped
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 400);
}

/** Strip list markers, quotes and conversational filler from a candidate. */
function clean(text: string): string {
  return text
    .replace(/^[-*>\d.\s]+/, "")
    .replace(/\s+/g, " ")
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/^(?:please|also|and|but|so|ok|okay|hey|hi|thanks|btw)[,\s]+/i, "")
    .trim();
}

/** Deterministic extraction from one message. */
export function extractHeuristic(text: string, role: "user" | "assistant" = "user"): Extracted[] {
  if (!text || text.length < 8) return [];
  const out: Extracted[] = [];
  const sentences = splitSentences(text);
  // Assistant self-narration is a poor memory source; only take explicit notes.
  const allowed = role === "user" ? RULES : RULES.filter((r) => r.kind === "note" || r.kind === "decision");

  // Explicit "remember that …" wins over everything.
  const explicit = /\b(?:remember|keep in mind|note)\s+(?:that\s+)?[:,]?\s+([^\n]{8,300})/i.exec(text);
  if (explicit) {
    out.push({ text: clean(explicit[1]!), kind: "note", confidence: 0.95 });
  }

  for (const sentence of sentences) {
    if (NOISE.test(sentence)) continue;
    if (/\?$/.test(sentence)) continue;
    if (sentence.length < 12) continue;
    for (const rule of allowed) {
      const m = rule.re.exec(sentence);
      if (!m) continue;
      let candidate = rule.group !== undefined ? m[rule.group]! : m[0]!;
      candidate = clean(candidate);
      // Trim overly long sentences at a clause boundary.
      if (candidate.length > 200) candidate = candidate.slice(0, 197).replace(/[,;:]?\s+\S*$/, "") + "…";
      if (candidate.length < 6) continue;
      if (out.some((e) => jaccard(tokenize(e.text), tokenize(candidate)) > 0.8)) continue;
      out.push({ text: candidate, kind: rule.kind, confidence: rule.confidence });
      break;
    }
  }
  return out.slice(0, 5);
}

const LLM_PROMPT = `You extract durable memories from a chat turn.
Return ONLY a JSON array (no prose, no markdown fence). Each element:
{"text": string, "kind": "preference"|"fact"|"decision"|"task"|"entity"|"note", "confidence": number}

Rules:
- Extract only information worth remembering across sessions: stable preferences, decisions, constraints, project facts, identity, open tasks.
- Skip pleasantries, transient reasoning, code, and anything the assistant merely suggested.
- Write each memory as a short standalone sentence that makes sense out of context.
- Never invent facts. Empty array is a valid answer.`;

/** LLM-assisted extraction; returns [] on any failure (never throws). */
export async function extractWithModel(
  router: RouterClient,
  model: string,
  turn: { user: string; assistant?: string },
  signal?: AbortSignal,
): Promise<Extracted[]> {
  const payload = `USER:\n${turn.user.slice(0, 4000)}\n\n${turn.assistant ? `ASSISTANT:\n${turn.assistant.slice(0, 3000)}` : ""}`;
  try {
    const { text } = await router.complete(
      {
        model,
        messages: [
          { role: "system", content: LLM_PROMPT },
          { role: "user", content: payload },
        ],
        temperature: 0,
        max_tokens: 500,
      },
      signal,
    );
    return validate(parseJsonArray(text));
  } catch {
    return [];
  }
}

function parseJsonArray(text: string): unknown[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const KINDS: MemoryKind[] = ["preference", "fact", "decision", "task", "entity", "note"];

function validate(raw: unknown[]): Extracted[] {
  const out: Extracted[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const text = typeof rec.text === "string" ? clean(rec.text) : "";
    if (text.length < 6 || text.length > 400) continue;
    if (/^(none|n\/a|nothing)$/i.test(text)) continue;
    const kind = KINDS.includes(rec.kind as MemoryKind) ? (rec.kind as MemoryKind) : "note";
    const confidence = typeof rec.confidence === "number" ? Math.min(1, Math.max(0, rec.confidence)) : 0.6;
    if (confidence < 0.4) continue;
    if (out.some((o) => jaccard(tokenize(o.text), tokenize(text)) > 0.8)) continue;
    out.push({ text, kind, confidence });
  }
  return out.slice(0, 8);
}

/** Filter candidates against what the bank already knows. */
export function novel(candidates: Extracted[], existing: MemoryItem[]): Extracted[] {
  const tokens = existing.filter((i) => !i.supersededBy).map((i) => tokenize(i.text));
  return candidates.filter((c) => {
    const t = tokenize(c.text);
    return !tokens.some((e) => jaccard(t, e) >= 0.82);
  });
}

const NEGATIVE = /\b(?:never|not|don'?t|avoid|no longer|instead of|avoid)\b/i;
/** Words that carry opinion rather than subject: ignored when matching topics. */
const OPINION = new Set(["never", "not", "dont", "avoid", "longer", "instead", "alway", "only", "use", "prefer", "like", "want", "need", "please", "tab"]);

function subjectTokens(text: string): string[] {
  const out = tokenize(text).filter((t) => !OPINION.has(t));
  // "tabs" is the subject in the canonical indentation argument, so keep it.
  if (/\btabs?\b/i.test(text)) out.push("tab");
  return out;
}

/**
 * Find memories a new statement contradicts: same subject, opposite polarity.
 * Uses containment rather than Jaccard so a short correction still matches a
 * longer original ("never use tabs" vs "always use tabs for indentation").
 */
export function contradictions(candidate: Extracted, existing: MemoryItem[]): MemoryItem[] {
  const candidateTokens = new Set(subjectTokens(candidate.text));
  const negative = NEGATIVE.test(candidate.text);
  if (!candidateTokens.size) return [];
  return existing.filter((item) => {
    if (item.supersededBy) return false;
    const other = new Set(subjectTokens(item.text));
    if (!other.size) return false;
    let shared = 0;
    for (const token of candidateTokens) if (other.has(token)) shared++;
    if (!shared) return false;
    const containment = shared / Math.min(candidateTokens.size, other.size);
    if (containment < 0.5) return false;
    return negative !== NEGATIVE.test(item.text);
  });
}
