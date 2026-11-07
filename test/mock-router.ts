/**
 * A local stand-in for nokey-router.
 *
 * Implements just enough of the real surface — SSE frames with routing
 * heartbeats, `nokey` telemetry, degraded responses, 429-then-succeed retries,
 * tool call deltas and the tool plane — to exercise the client, engine and UI
 * without network access.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

export interface MockOptions {
  port?: number;
  host?: string;
  /** Delay between content chunks in ms. */
  chunkDelayMs?: number;
  /** Force a degraded response. */
  degraded?: boolean;
  /** Fail the first N chat requests with 429. */
  rateLimitFirst?: number;
}

export interface MockHandle {
  port: number;
  url: string;
  close(): Promise<void>;
  requests: Array<{ method: string; path: string; at: number }>;
}

const REASONING = "The user wants a concrete answer. I'll check the router contract first, then outline the streaming parser and the retry policy.";

const ANSWER = `Here's a minimal streaming client for **nokey-router**.

## Why it works

The router sends \`: routing\` heartbeats until an upstream commits, so the
client must not treat comments as errors.

\`\`\`ts title="client.ts"
export async function* chat(prompt: string) {
  const res = await fetch("https://nokey-router.ziggyware.deno.net/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: \`Bearer \${key}\` },
    body: JSON.stringify({ model: "free:smart", stream: true, messages: [{ role: "user", content: prompt }] }),
  });
  // chunks arrive as SSE data frames
  return res.body;
}
\`\`\`

| lane | best for | typical ttft |
|:--|:--|--:|
| \`free:fast\` | short answers | 400 ms |
| \`free:smart\` | reasoning | 900 ms |
| \`free:code\` | code generation | 700 ms |

- retry **only** on 429/5xx
- honour \`Retry-After\`
- abort on an idle stream

> Tip: pass \`traceparent\` to join your own traces.
`;

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    ...extra,
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function lastUserText(body: Record<string, unknown>): string {
  const messages = (body.messages as Array<{ role: string; content: string }> | undefined) ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i]!.content ?? "";
  }
  return "";
}

export async function startMockRouter(opts: MockOptions = {}): Promise<MockHandle> {
  const requests: MockHandle["requests"] = [];
  const chunkDelay = opts.chunkDelayMs ?? 0;
  let chatCount = 0;
  const rateLimitFirst = opts.rateLimitFirst ?? 0;

  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    requests.push({ method: req.method ?? "GET", path: url, at: Date.now() });

    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
      res.end();
      return;
    }

    if (url === "/health") {
      json(res, 200, {
        ok: true,
        kernel: { lanes: { fast: 8, smart: 11, code: 9, reasoning: 6 }, coverage: 0.93 },
        top: { smart: ["alpha", "beta", "gamma"] },
      });
      return;
    }

    if (url === "/v1/models") {
      json(res, 200, {
        object: "list",
        aliases: ["free:auto", "free:fast", "free:smart", "free:code", "free:reasoning"],
        data: [
          { id: "free:auto", provider: "mesh", iq: 80, context_length: 128000 },
          { id: "free:smart", provider: "mesh", iq: 88, context_length: 200000 },
          { id: "free:code", provider: "mesh", iq: 84, context_length: 200000 },
          { id: "meta/llama-3.3-70b", provider: "openrouter", iq: 79, context_length: 131072 },
          { id: "qwen/qwen3-coder", provider: "huggingface", iq: 83, context_length: 262144 },
        ],
      });
      return;
    }

    if (url.startsWith("/v1/tools/execute")) {
      const body = await readBody(req);
      const name = String(body.name ?? (Array.isArray(body.calls) ? "batch" : "unknown"));
      json(res, 200, {
        ok: true,
        results: [{ name, ok: true, value: 42, parse: "json" }],
        nokey: { tool: name },
      });
      return;
    }

    if (url.startsWith("/v1/tools")) {
      json(res, 200, {
        object: "list",
        data: [
          { name: "calculate", description: "Evaluate a mathematical expression.", calls: 1204, competence: 0.98 },
          { name: "memory_search", description: "Search durable memory.", calls: 88, competence: 0.91 },
          { name: "web_search", description: "Search the web.", calls: 340, competence: 0.72 },
        ],
      });
      return;
    }

    if (url.startsWith("/v1/feedback")) {
      await readBody(req);
      json(res, 200, { ok: true, joined: true });
      return;
    }

    if (url.startsWith("/v1/chat/completions")) {
      chatCount++;
      const body = await readBody(req);
      const prompt = lastUserText(body);

      if (chatCount <= rateLimitFirst) {
        json(res, 429, { error: { message: "rate limited by upstream pool", code: "rate_limited" } }, { "retry-after": "0" });
        return;
      }
      if (!body.messages) {
        json(res, 400, { error: { message: "messages required", code: "bad_request" } });
        return;
      }
      if (String(prompt).includes("__401__")) {
        json(res, 401, { error: { message: "invalid api key", code: "unauthorized" } });
        return;
      }

      const wantsTools = body.tools === "auto";
      const streamFlag = body.stream !== false;

      if (!streamFlag) {
        json(
          res,
          200,
          {
            id: "cmpl_mock",
            object: "chat.completion",
            model: String(body.model ?? "free:auto"),
            choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }],
            usage: { prompt_tokens: 42, completion_tokens: 180, total_tokens: 222 },
            nokey: { attempts: 1, endpoints: 2, lane: "smart" },
          },
          { "x-nokey-attempts": "1", "x-nokey-endpoints": "2", "server-timing": "ttft;dur=310, total;dur=1420", traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
        );
        return;
      }

      const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
        "x-nokey-attempts": "1",
        "x-nokey-endpoints": "3",
        ...(opts.degraded ? { "x-nokey-degraded": "1" } : {}),
        traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
      });

      const write = (chunk: string) => {
        if (!res.writableEnded) res.write(chunk);
      };
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

      write(": trace 4bf92f35 route=smart\n\n");
      write(": routing lane=smart candidates=3 best=alpha\n\n");
      if (chunkDelay > 0) await wait(chunkDelay);

      const base = {
        id: "cmpl_mock",
        object: "chat.completion.chunk",
        model: String(body.model ?? "free:auto"),
      };

      const emitReasoning = (text: string) => {
        write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] })}\n\n`);
      };
      const emit = (text: string) => {
        write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
      };

      if (String(prompt).includes("__noreasoning__") === false) {
        for (const piece of splitChunks(REASONING, 12)) {
          emitReasoning(piece);
          if (chunkDelay > 0) await wait(chunkDelay);
        }
      }

      if (wantsTools) {
        write(
          `data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "calculate", arguments: '{"expr' } }] }, finish_reason: null }],
          })}\n\n`,
        );
        write(
          `data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ession":"2+2"}' } }] }, finish_reason: null }],
          })}\n\n`,
        );
      }

      const answer = String(prompt).includes("__short__") ? "Pong." : ANSWER;
      for (const piece of splitChunks(answer, 9)) {
        emit(piece);
        if (chunkDelay > 0) await wait(chunkDelay);
      }

      write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 64, completion_tokens: 210, total_tokens: 274 },
          nokey: {
            attempts: 1,
            endpoints: 3,
            degraded: Boolean(opts.degraded),
            traceId,
            lane: "smart",
            model: String(body.model ?? "free:auto"),
          },
        })}\n\n`,
      );
      write("data: [DONE]\n\n");
      res.end();
      return;
    }

    json(res, 404, { error: { message: `mock: no route for ${url}`, code: "not_found" } });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 0);
  return {
    port,
    url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
    requests,
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

function splitChunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

// `npm run mock` starts a standalone instance for manual testing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8799);
  const handle = await startMockRouter({ port, chunkDelayMs: Number(process.env.DELAY ?? 25) });
  process.stdout.write(`mock router on ${handle.url}\n`);
}
