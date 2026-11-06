/**
 * Token estimation.
 *
 * No tokenizer ships with the CLI (that would mean a dependency and a model
 * file), but budget decisions need to be roughly right. The estimator is tuned
 * against BPE behaviour: prose ≈ 4.1 chars/token, code and JSON denser, CJK
 * closer to 1 char/token.
 */
export interface TokenEstimate {
  tokens: number;
  chars: number;
  /** Characters per token actually used. */
  ratio: number;
}

const CJK = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(CJK) ?? []).length;
  if (cjk > text.length * 0.3) return Math.ceil(text.length / 1.1);
  const codeish = (text.match(/[{}()[\];=<>|&_$#@~/\\]/g) ?? []).length;
  const density = codeish / Math.max(1, text.length);
  const charsPerToken = density > 0.12 ? 3.1 : density > 0.06 ? 3.6 : 4.2;
  return Math.max(1, Math.ceil(text.length / charsPerToken));
}

export function estimate(text: string): TokenEstimate {
  const tokens = estimateTokens(text);
  return { tokens, chars: text.length, ratio: text.length / Math.max(1, tokens) };
}

/** Rough per-message framing overhead (role markers, separators). */
export const MESSAGE_OVERHEAD_TOKENS = 4;

export interface TokenizableMessage {
  role: string;
  content?: string | null;
  reasoning?: string | null;
  tool_calls?: unknown;
}

export function estimateMessages(messages: TokenizableMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += MESSAGE_OVERHEAD_TOKENS;
    if (m.content) total += estimateTokens(m.content);
    if (m.reasoning) total += estimateTokens(m.reasoning);
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return total;
}

/** Format a token count compactly: 987, 12.4k, 1.2M. */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
