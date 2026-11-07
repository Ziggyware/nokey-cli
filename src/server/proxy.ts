/**
 * Local gateway (Node adapter).
 *
 * Runs the shared gateway core in-process and exposes it over `node:http`, so
 * every behaviour that ships to a deployed val — CORS, key injection, streaming
 * passthrough, path allowlists — is the identical code path exercised locally.
 *
 * Unlike the public deployment this adapter proxies the *full* `/v1/*` surface,
 * admin routes included, because it only listens on loopback and the operator
 * already holds the admin secret.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { NoKeyRouter } from "../router/client.ts";
import type { ConfigStore } from "../store/config.ts";
import type { GatewayEnv } from "./gateway.ts";
import { handleGatewayDetailed } from "./gateway.ts";
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

/** Local gateways get the whole surface; public ones get an allowlist. */
export function localGatewayEnv(router: NoKeyRouter, config: ConfigStore): GatewayEnv {
  return {
    ROUTER_API_KEY: router.hasKey ? config.value.router.apiKey : undefined,
    NOKEY_BASE_URL: router.baseUrl,
    NOKEY_ALLOW_ORIGIN: "*",
    NOKEY_ALLOW: "/v1/",
    NOKEY_ALLOW_ADMIN: "1",
    NOKEY_ALLOW_ADMIN_SECRET: "1",
    NOKEY_GATEWAY_NAME: "Local gateway to nokey-router",
  };
}

function toRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "127.0.0.1";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on("close", () => {
    if (!res.writableEnded) void reader.cancel().catch(() => {});
  });
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (!res.write(Buffer.from(value))) {
      await new Promise<void>((resolve) => res.once("drain", () => resolve()));
    }
  }
  res.end();
}

export async function startProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  const env = localGatewayEnv(opts.router, opts.config);
  const server = createServer(async (req, res) => {
    try {
      const result = await handleGatewayDetailed(toRequest(req), {
        env,
        version: VERSION,
        adminSecret: opts.config.value.router.adminSecret,
      });
      await writeResponse(res, result.response);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: (err as Error).message, code: "gateway_failure" } }));
      } else {
        res.end();
      }
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
