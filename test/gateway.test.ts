import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { handleGateway, GATEWAY_VERSION, PUBLIC_PATHS } from "../src/server/gateway.ts";
import { startProxy } from "../src/server/proxy.ts";
import { renderVal, VAL_PATH } from "../scripts/build-valtown.ts";

/** A router stand-in that records what the gateway actually forwarded. */
interface Upstream {
  url: string;
  seen: Array<{ path: string; auth?: string; admin?: string; body: string; method: string }>;
  close(): Promise<void>;
  doneAt: () => number;
}

async function startUpstream(opts: { fail?: boolean } = {}): Promise<Upstream> {
  const seen: Upstream["seen"] = [];
  let doneAt = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = Buffer.concat(chunks).toString("utf8");
    seen.push({
      path: req.url ?? "/",
      method: req.method ?? "GET",
      body,
      ...(req.headers.authorization ? { auth: String(req.headers.authorization) } : {}),
      ...(req.headers["x-admin-secret"] ? { admin: String(req.headers["x-admin-secret"]) } : {}),
    });
    if (opts.fail) {
      res.destroy();
      return;
    }
    if (req.url?.startsWith("/v1/chat/completions")) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-nokey-attempts": "1",
        "x-nokey-endpoints": "alpha",
      });
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
      await new Promise((r) => setTimeout(r, 250));
      res.write('data: {"choices":[{"delta":{"content":"second"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      doneAt = Date.now();
      res.end();
      return;
    }
    if (req.url === "/v1/traces") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ traces: [{ id: "deadbeef" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, echoed: seen.length }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    doneAt: () => doneAt,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function gatewayAt(upstreamUrl: string, env: Record<string, string> = {}) {
  return (req: Request) =>
    handleGateway(req, {
      env: { NOKEY_BASE_URL: upstreamUrl, ROUTER_API_KEY: "router-key", ...env },
      version: "test",
    });
}

const msg = (path: string, init: RequestInit = {}) => new Request(`https://gw.example${path}`, init);

test("preflight answers 204 with CORS and never reaches upstream", async () => {
  const up = await startUpstream();
  try {
    const call = gatewayAt(up.url);
    const res = await call(msg("/v1/chat/completions", { method: "OPTIONS" }));
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /authorization/);
    assert.match(res.headers.get("access-control-expose-headers") ?? "", /x-nokey-attempts/);
    assert.equal(up.seen.length, 0);
  } finally {
    await up.close();
  }
});

test("landing page documents upstream, key policy and the deployed origin", async () => {
  const up = await startUpstream();
  try {
    const res = await gatewayAt(up.url)(msg("/"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, new RegExp(up.url));
    assert.match(html, /curl -N https:\/\/gw\.example\/v1\/chat\/completions/);
    assert.match(html, /server key is injected/);
    assert.match(html, /nokey-cli test/);
    assert.doesNotMatch(html, /router-key/);
  } finally {
    await up.close();
  }
});

test("healthz reports configuration without leaking the key", async () => {
  const up = await startUpstream();
  try {
    const res = await gatewayAt(up.url, { NOKEY_ALLOW_ADMIN: "0" })(msg("/healthz"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.keyConfigured, true);
    assert.equal(body.adminExposed, false);
    assert.deepEqual(body.publicPaths, [...PUBLIC_PATHS]);
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes("router-key"), "key must never appear in healthz");
  } finally {
    await up.close();
  }
});

test("injects the server key when the caller sends none", async () => {
  const up = await startUpstream();
  try {
    await gatewayAt(up.url)(msg("/v1/models"));
    assert.equal(up.seen[0]?.auth, "Bearer router-key");
  } finally {
    await up.close();
  }
});

test("honours the caller's own key unless forced", async () => {
  const up = await startUpstream();
  try {
    await gatewayAt(up.url)(msg("/v1/models", { headers: { authorization: "Bearer caller-key" } }));
    assert.equal(up.seen[0]?.auth, "Bearer caller-key");
    await gatewayAt(up.url, { NOKEY_FORCE_KEY: "1" })(
      msg("/v1/models", { headers: { authorization: "Bearer caller-key" } }),
    );
    assert.equal(up.seen[1]?.auth, "Bearer router-key");
  } finally {
    await up.close();
  }
});

test("sends no credentials at all when the deployment has no key", async () => {
  const up = await startUpstream();
  try {
    await handleGateway(msg("/v1/models"), { env: { NOKEY_BASE_URL: up.url } });
    assert.equal(up.seen[0]?.auth, undefined);
  } finally {
    await up.close();
  }
});

test("admin routes are blocked and never forwarded", async () => {
  const up = await startUpstream();
  try {
    const res = await gatewayAt(up.url)(msg("/v1/traces"));
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "admin_route_blocked");
    assert.equal(up.seen.length, 0, "blocked routes must not reach the router");
  } finally {
    await up.close();
  }
});

test("admin routes work only when enabled, and secrets are not forwarded by default", async () => {
  const up = await startUpstream();
  try {
    const enabled = gatewayAt(up.url, { NOKEY_ALLOW_ADMIN: "1" });
    const res = await enabled(msg("/v1/traces", { headers: { "x-admin-secret": "caller-secret" } }));
    assert.equal(res.status, 200);
    assert.equal(up.seen[0]?.path, "/v1/traces");
    assert.equal(up.seen[0]?.admin, undefined, "admin secret must not pass through by default");

    const passthrough = gatewayAt(up.url, { NOKEY_ALLOW_ADMIN: "1", NOKEY_ALLOW_ADMIN_SECRET: "1" });
    await passthrough(msg("/v1/traces", { headers: { "x-admin-secret": "caller-secret" } }));
    assert.equal(up.seen[1]?.admin, "caller-secret");
  } finally {
    await up.close();
  }
});

test("a gateway can require the caller's own key", async () => {
  const up = await startUpstream();
  try {
    const guarded = gatewayAt(up.url, { NOKEY_REQUIRE_CLIENT_KEY: "1" });
    const anonymous = await guarded(msg("/v1/chat/completions", { method: "POST", body: "{}" }));
    assert.equal(anonymous.status, 401);
    const body = (await anonymous.json()) as { error: { code: string } };
    assert.equal(body.error.code, "client_key_required");
    assert.equal(up.seen.length, 0, "guarded gateways must not fall back to the server key");

    const withKey = await guarded(
      msg("/v1/models", { headers: { authorization: "Bearer caller-key" } }),
    );
    assert.equal(withKey.status, 200);
    assert.equal(up.seen[0]?.auth, "Bearer caller-key");

    const health = (await (await guarded(msg("/healthz"))).json()) as { requireClientKey: boolean };
    assert.equal(health.requireClientKey, true);
  } finally {
    await up.close();
  }
});

test("unknown paths 404 and list what is proxied", async () => {
  const up = await startUpstream();
  try {
    const res = await gatewayAt(up.url)(msg("/v1/secrets"));
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string; proxied: string[] } };
    assert.equal(body.error.code, "not_found");
    assert.ok(body.error.proxied.includes("/v1/chat/completions"));
    assert.equal(up.seen.length, 0);
  } finally {
    await up.close();
  }
});

test("NOKEY_ALLOW widens the allowlist for operators", async () => {
  const up = await startUpstream();
  try {
    const res = await gatewayAt(up.url, { NOKEY_ALLOW: "/v1/custom/, /v1/models" })(
      msg("/v1/custom/thing"),
    );
    assert.equal(res.status, 200);
    assert.equal(up.seen[0]?.path, "/v1/custom/thing");
  } finally {
    await up.close();
  }
});

test("rejects bodies over the cap before touching the router", async () => {
  const up = await startUpstream();
  try {
    const res = await gatewayAt(up.url)(
      msg("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "9000000" },
        body: "{}",
      }),
    );
    assert.equal(res.status, 413);
    assert.equal(up.seen.length, 0);
  } finally {
    await up.close();
  }
});

test("an unreachable router becomes a clean 502, not a crash", async () => {
  const handler = gatewayAt("http://127.0.0.1:9");
  const res = await handler(msg("/v1/models"));
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "upstream_unreachable");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("streams SSE incrementally, preserving upstream headers", async () => {
  const up = await startUpstream();
  try {
    const res = await gatewayAt(up.url)(
      msg("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream: true, messages: [] }),
      }),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(res.headers.get("x-nokey-attempts"), "1");
    assert.equal(res.headers.get("x-nokey-gateway"), "nokey-gateway/test");
    assert.equal(res.headers.get("content-length"), null, "streams must not be length-delimited");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(up.seen[0]?.body, JSON.stringify({ stream: true, messages: [] }));

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    const firstAt = Date.now();
    let text = decoder.decode(first.value);
    assert.match(text, /first/);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    assert.match(text, /second/);
    assert.match(text, /\[DONE\]/);
    assert.ok(
      firstAt < up.doneAt() - 100,
      `first chunk should arrive well before the stream ends (${firstAt} vs ${up.doneAt()})`,
    );
  } finally {
    await up.close();
  }
});

test("the Node adapter runs the same core: CORS, key injection, full local surface", async () => {
  const up = await startUpstream();
  const router = { hasKey: true, baseUrl: up.url } as never;
  const config = { value: { router: { apiKey: "local-key", adminSecret: "local-admin" } } } as never;
  const proxy = await startProxy({ router, config, port: 0, host: "127.0.0.1" });
  try {
    const models = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`);
    assert.equal(models.status, 200);
    assert.equal(models.headers.get("access-control-allow-origin"), "*");
    assert.equal(up.seen.at(-1)?.auth, "Bearer local-key");

    const landing = await fetch(`http://127.0.0.1:${proxy.port}/`);
    assert.match(await landing.text(), /Local gateway to nokey-router/);

    // The local gateway keeps the full surface, admin included.
    const traces = await fetch(`http://127.0.0.1:${proxy.port}/v1/traces`);
    assert.equal(traces.status, 200);
    assert.equal(up.seen.at(-1)?.admin, "local-admin", "local proxy supplies the admin secret");

    // Streaming must survive the Node adapter, not just the core.
    const chat = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [] }),
    });
    assert.match(chat.headers.get("content-type") ?? "", /text\/event-stream/);
    const sse = await chat.text();
    assert.match(sse, /first/);
    assert.match(sse, /\[DONE\]/);
  } finally {
    proxy.close();
    await up.close();
  }
});

test("the committed val matches the generator and is import-free", () => {
  assert.ok(existsSync(VAL_PATH), "deploy/valtown/nokey-gateway.ts must be committed");
  const committed = readFileSync(VAL_PATH, "utf8");
  assert.equal(committed, renderVal(), "run `npm run build:valtown` — the val has drifted from src/server/gateway.ts");
  assert.match(committed, /export default async function nokeyGateway\(request: Request\)/);
  assert.doesNotMatch(committed, /^\s*import\s/m, "a Val Town val must be a single self-contained file");
  assert.doesNotMatch(committed, /from "\.\.?\//, "no relative imports allowed");
});

test("the val file actually serves requests end to end", async () => {
  const up = await startUpstream();
  const previous = { ...process.env };
  process.env.ROUTER_API_KEY = "val-key";
  process.env.NOKEY_BASE_URL = up.url;
  process.env.NOKEY_GATEWAY_NAME = "nokey-gateway-test";
  try {
    const mod = (await import(VAL_PATH)) as { default: (r: Request) => Promise<Response> };
    const res = await mod.default(new Request("https://my-val.web.val.run/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
    }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /event-stream/);
    const text = await res.text();
    assert.match(text, /\[DONE\]/);
    assert.equal(up.seen[0]?.auth, "Bearer val-key");

    const health = (await (await mod.default(new Request("https://my-val.web.val.run/healthz"))).json()) as {
      gateway: string;
      keyConfigured: boolean;
    };
    assert.equal(health.gateway, "nokey-gateway-test");
    assert.equal(health.keyConfigured, true);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await up.close();
  }
});

test("the val blocks admin routes by default", async () => {
  const up = await startUpstream();
  const previous = { ...process.env };
  process.env.ROUTER_API_KEY = "val-key";
  process.env.NOKEY_BASE_URL = up.url;
  delete process.env.NOKEY_ALLOW_ADMIN;
  try {
    const mod = (await import(VAL_PATH)) as { default: (r: Request) => Promise<Response> };
    const res = await mod.default(new Request("https://my-val.web.val.run/v1/traces"));
    assert.equal(res.status, 403);
    assert.equal(up.seen.length, 0);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await up.close();
  }
});

test("the smoke script exists for post-deploy verification", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "scripts", "check-gateway.ts"), "utf8");
  assert.match(source, /healthz/);
  assert.match(source, /\/v1\/models/);
  assert.match(source, /chat\/completions/);
});
