/**
 * Local gateway.
 *
 * Browsers cannot stream from the router when CORS or a corporate proxy gets in
 * the way, and other tools want a stable localhost URL. This server forwards
 * `/v1/*` and `/health` verbatim — including SSE chunks and upstream headers —
 * injects the configured key, and answers preflight requests.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NoKeyRouter } from "../router/client.ts";
import type { ConfigStore } from "../store/config.ts";
import { VERSION } from "../version.ts";

export interface ProxyOptions {
  router: NoKeyRouter;
  config: ConfigStore;
  port: number;
  host: string;
}

export interface ProxyHandle {
  port: number;
  close(): void;
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-admin-secret, traceparent, accept",
  "access-control-expose-headers": "x-nokey-attempts, x-nokey-endpoints, x-nokey-degraded, traceparent, server-timing",
  "access-control-max-age": "86400",
};

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function startProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { ...CORS_HEADERS, "content-type": "text/html; charset=utf-8" });
      res.end(landingPage(opts));
      return;
    }
    if (!url.startsWith("/v1/") && url !== "/health") {
      res.writeHead(404, { ...CORS_HEADERS, "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `nokey proxy: ${url} is not proxied`, code: "not_found" } }));
      return;
    }

    const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : undefined;
    const headers: Record<string, string> = {
      accept: req.headers.accept ?? "application/json",
      "user-agent": `nokey-cli/${VERSION} (proxy)`,
    };
    if (req.headers["content-type"]) headers["content-type"] = String(req.headers["content-type"]);
    if (req.headers.authorization) headers.authorization = String(req.headers.authorization);
    else if (opts.router.hasKey) headers.authorization = `Bearer ${opts.config.value.router.apiKey}`;
    if (req.headers["x-admin-secret"]) headers["x-admin-secret"] = String(req.headers["x-admin-secret"]);
    else if (opts.config.value.router.adminSecret) headers["x-admin-secret"] = opts.config.value.router.adminSecret;
    if (req.headers.traceparent) headers.traceparent = String(req.headers.traceparent);

    try {
      const upstream = await fetch(`${opts.router.baseUrl}${url}`, {
        method: req.method ?? "GET",
        headers,
        ...(body && body.length ? { body: new Uint8Array(body) } : {}),
      });
      const outHeaders: Record<string, string> = { ...CORS_HEADERS };
      upstream.headers.forEach((value, key) => {
        if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key.toLowerCase())) return;
        outHeaders[key] = value;
      });
      res.writeHead(upstream.status, outHeaders);
      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && !res.write(Buffer.from(value))) {
            await new Promise<void>((r) => res.once("drain", () => r()));
          }
        }
        res.end();
      };
      req.on("close", () => {
        void reader.cancel().catch(() => {});
      });
      await pump();
    } catch (err) {
      res.writeHead(502, { ...CORS_HEADERS, "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: `proxy upstream failed: ${(err as Error).message}`, code: "upstream_unreachable" },
          nokey: { proxy: true },
        }),
      );
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  return {
    port,
    close: () => server.close(),
  };
}

function landingPage(opts: ProxyOptions): string {
  const base = opts.router.baseUrl;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>nokey proxy</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0b0f14; color:#e6edf3;
         font:15px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 720px; padding: 32px; }
  h1 { color:#5ad1ff; font-size:20px; margin:0 0 4px; }
  p.lead { color:#8b98a5; margin:0 0 24px; }
  code { background:#132433; color:#8df0b6; padding:1px 6px; border-radius:4px; }
  pre { background:#0d1720; border:1px solid #22303c; border-radius:8px; padding:16px; overflow:auto; }
  a { color:#79b8ff; }
  .badge { display:inline-block; background:#132433; color:#b48cff; border-radius:999px; padding:2px 10px; font-size:12px; }
</style></head>
<body><main>
  <span class="badge">nokey-cli ${VERSION}</span>
  <h1>Local gateway to nokey-router</h1>
  <p class="lead">Streaming passthrough with CORS enabled. Upstream: ${base}</p>
  <p>Chat (SSE):</p>
  <pre>curl -N http://127.0.0.1:${opts.port}/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{"model":"free:auto","stream":true,"messages":[{"role":"user","content":"ping"}]}'</pre>
  <p>From a browser: <code>fetch("http://127.0.0.1:${opts.port}/v1/models")</code></p>
  <p>Also proxied: <code>/health</code>, <code>/v1/models</code>, <code>/v1/tools</code>, <code>/v1/tools/execute</code>, <code>/v1/images/generations</code>.</p>
</main></body></html>`;
}
