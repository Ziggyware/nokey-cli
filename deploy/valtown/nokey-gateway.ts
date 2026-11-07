/**
 * nokey gateway — Val Town HTTP val (GENERATED, do not edit by hand).
 *
 * Source of truth: src/server/gateway.ts in the nokey-cli repo.
 * Rebuild with: npm run build:valtown
 *
 * Deploy: create an HTTP val, paste this file, save, then set the environment
 * variable ROUTER_API_KEY (and optionally NOKEY_ALLOW_ORIGIN, NOKEY_BASE_URL).
 *
 * Everything below the marker is the shared gateway core, inlined so the val
 * stays a single file with no imports.
 */

// ───────────────────── shared gateway core ─────────────────────

const GATEWAY_VERSION = "1.0.0";
const DEFAULT_ROUTER = "https://nokey-router.ziggyware.deno.net";

/** Paths a public gateway will forward. Prefixes end with "/". */
const PUBLIC_PATHS = [
  "/health",
  "/v1/models",
  "/v1/endpoints",
  "/v1/chat/completions",
  "/v1/tools",
  "/v1/tools/execute",
  "/v1/images/generations",
  "/v1/community/",
] as const;

/** Paths that stay closed unless the operator opts in explicitly. */
const ADMIN_PATHS = [
  "/v1/traces",
  "/v1/probe",
  "/v1/sync",
  "/v1/resurrect",
  "/v1/source",
  "/v1/learning",
  "/v1/tools/forge",
  "/v1/whoami",
  "/v1/admin",
] as const;

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
] as const;

interface GatewayEnv {
  /** Router key used when the caller does not send one. */
  ROUTER_API_KEY?: string;
  /** Router origin; defaults to the public deployment. */
  NOKEY_BASE_URL?: string;
  /** `*` by default; set an origin to lock the gateway down. */
  NOKEY_ALLOW_ORIGIN?: string;
  /** Comma-separated extra path prefixes to expose. */
  NOKEY_ALLOW?: string;
  /** `1` exposes the admin surface (caller must still supply x-admin-secret). */
  NOKEY_ALLOW_ADMIN?: string;
  /** `1` ignores caller credentials and always signs with ROUTER_API_KEY. */
  NOKEY_FORCE_KEY?: string;
  /**
   * `1` refuses callers who send no `authorization` header, so a public URL
   * never spends the deployment's key on strangers.
   */
  NOKEY_REQUIRE_CLIENT_KEY?: string;
  /** `1` strips the client's x-admin-secret header (default when admin is off). */
  NOKEY_ALLOW_ADMIN_SECRET?: string;
  /** Set to `0` to disable the HTML landing page. */
  NOKEY_LANDING?: string;
  /** Tag shown in responses and on the landing page. */
  NOKEY_GATEWAY_NAME?: string;
}

interface GatewayOptions {
  env: GatewayEnv;
  /** Version of the client this gateway ships with. */
  version?: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  maxBodyBytes?: number;
  /**
   * Admin secret the deployment holds. Only used when NOKEY_ALLOW_ADMIN=1 and
   * the operator did not set NOKEY_ALLOW_ADMIN_SECRET (i.e. the local proxy).
   */
  adminSecret?: string;
}

interface GatewayResult {
  response: Response;
  /** What the handler decided, for logging and tests. */
  route: "preflight" | "landing" | "healthz" | "proxy" | "denied" | "not_found" | "error";
  upstreamPath?: string;
}

const MAX_BODY = 2_000_000;

function corsHeaders(env: GatewayEnv): Record<string, string> {
  const origin = env.NOKEY_ALLOW_ORIGIN?.trim() || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, x-admin-secret, traceparent, accept, x-nokey-room",
    "access-control-expose-headers":
      "x-nokey-attempts, x-nokey-endpoints, x-nokey-degraded, x-nokey-gateway, traceparent, server-timing",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function matches(pathname: string, allowed: readonly string[]): boolean {
  return allowed.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p));
}

/** Decide whether a path may be forwarded. */
function routeOf(pathname: string, env: GatewayEnv): "proxy" | "denied" | "not_found" {
  const extra = (env.NOKEY_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const adminOn = env.NOKEY_ALLOW_ADMIN === "1";
  const isAdmin = matches(pathname, ADMIN_PATHS);
  if (isAdmin) {
    if (!adminOn) return "denied";
    return "proxy";
  }
  if (matches(pathname, PUBLIC_PATHS)) return "proxy";
  if (extra.length && extra.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p))) return "proxy";
  return "not_found";
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

/** The handler both the local proxy and the deployed val call. */
async function handleGatewayDetailed(
  request: Request,
  options: GatewayOptions,
): Promise<GatewayResult> {
  const env = options.env;
  const cors = corsHeaders(env);
  const doFetch = options.fetchImpl ?? fetch;
  const maxBody = options.maxBodyBytes ?? MAX_BODY;
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") {
    return { route: "preflight", response: new Response(null, { status: 204, headers: cors }) };
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return {
      route: "denied",
      response: json(405, { error: { message: "only GET and POST are proxied", code: "method_not_allowed" } }, cors),
    };
  }
  if (pathname === "/" || pathname === "/index.html") {
    if (env.NOKEY_LANDING === "0") return { route: "not_found", response: json(404, { error: { code: "landing_disabled" } }, cors) };
    return {
      route: "landing",
      response: new Response(landingPage(env, options.version ?? GATEWAY_VERSION, url.origin), {
        status: 200,
        headers: { ...cors, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      }),
    };
  }
  if (pathname === "/healthz" || pathname === "/nokey/healthz") {
    return {
      route: "healthz",
      response: json(
        200,
        {
          ok: true,
          gateway: env.NOKEY_GATEWAY_NAME ?? "nokey-gateway",
          version: options.version ?? GATEWAY_VERSION,
          upstream: (env.NOKEY_BASE_URL ?? DEFAULT_ROUTER).replace(/\/+$/, ""),
          keyConfigured: Boolean(env.ROUTER_API_KEY),
          requireClientKey: env.NOKEY_REQUIRE_CLIENT_KEY === "1",
          streaming: true,
          publicPaths: PUBLIC_PATHS,
          adminExposed: env.NOKEY_ALLOW_ADMIN === "1",
        },
        cors,
      ),
    };
  }

  const decision = routeOf(pathname, env);
  if (decision === "denied") {
    return {
      route: "denied",
      response: json(
        403,
        {
          error: {
            message: `${pathname} is an admin route; this gateway does not expose admin endpoints`,
            code: "admin_route_blocked",
            hint: "run `nokey proxy` locally, or set NOKEY_ALLOW_ADMIN=1 and send x-admin-secret yourself",
          },
          nokey: { gateway: true },
        },
        cors,
      ),
    };
  }
  if (decision === "not_found") {
    return {
      route: "not_found",
      response: json(
        404,
        {
          error: {
            message: `${pathname} is not proxied`,
            code: "not_found",
            proxied: PUBLIC_PATHS,
          },
          nokey: { gateway: true },
        },
        cors,
      ),
    };
  }

  // A public deployment can insist that callers bring their own key, which
  // keeps the URL from becoming a free proxy for the operator's quota.
  if (env.NOKEY_REQUIRE_CLIENT_KEY === "1" && !request.headers.get("authorization")) {
    return {
      route: "denied",
      response: json(
        401,
        {
          error: {
            message: "this gateway requires your own router key",
            code: "client_key_required",
            hint: "send `authorization: Bearer <ROUTER_API_KEY>`",
          },
          nokey: { gateway: true },
        },
        cors,
      ),
    };
  }

  // Body guard: refuse anything that would burn a serverless invocation.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBody) {
    return {
      route: "denied",
      response: json(413, { error: { message: `request body exceeds ${maxBody} bytes`, code: "payload_too_large" } }, cors),
    };
  }

  const upstreamBase = (env.NOKEY_BASE_URL ?? DEFAULT_ROUTER).replace(/\/+$/, "");
  const headers = new Headers();
  headers.set("accept", request.headers.get("accept") ?? "application/json");
  headers.set("user-agent", `nokey-gateway/${options.version ?? GATEWAY_VERSION}`);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const traceparent = request.headers.get("traceparent");
  if (traceparent) headers.set("traceparent", traceparent);

  // Credentials: the deployment's key by default, the caller's when they bring one.
  const callerKey = request.headers.get("authorization");
  if (env.NOKEY_FORCE_KEY === "1" && env.ROUTER_API_KEY) headers.set("authorization", `Bearer ${env.ROUTER_API_KEY}`);
  else if (callerKey) headers.set("authorization", callerKey);
  else if (env.ROUTER_API_KEY) headers.set("authorization", `Bearer ${env.ROUTER_API_KEY}`);

  // Admin secrets are never injected on a public gateway; forward only if the
  // operator both enables admin routes and allows pass-through.
  const adminSecret = request.headers.get("x-admin-secret");
  if (env.NOKEY_ALLOW_ADMIN === "1") {
    if (adminSecret && env.NOKEY_ALLOW_ADMIN_SECRET === "1") headers.set("x-admin-secret", adminSecret);
    else if (!adminSecret && options.adminSecret) headers.set("x-admin-secret", options.adminSecret);
  }

  const init: RequestInit = { method: request.method, headers };
  if (request.method === "POST") {
    // Stream the caller's body straight through: chat payloads can be large.
    init.body = request.body ?? undefined;
    init.duplex = "half";
  }

  try {
    const upstream = await doFetch(`${upstreamBase}${pathname}${url.search}`, init);
    const outHeaders = new Headers(cors);
    upstream.headers.forEach((value, key) => {
      if ((HOP_BY_HOP as readonly string[]).includes(key.toLowerCase())) return;
      outHeaders.set(key, value);
    });
    outHeaders.set("x-nokey-gateway", `nokey-gateway/${options.version ?? GATEWAY_VERSION}`);
    if ((upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
      outHeaders.set("cache-control", "no-store");
      outHeaders.set("x-accel-buffering", "no");
    }
    return {
      route: "proxy",
      upstreamPath: pathname,
      response: new Response(upstream.body, { status: upstream.status, headers: outHeaders }),
    };
  } catch (err) {
    return {
      route: "error",
      upstreamPath: pathname,
      response: json(
        502,
        {
          error: {
            message: `upstream fetch failed: ${(err as Error).message}`,
            code: "upstream_unreachable",
            upstream: upstreamBase,
          },
          nokey: { gateway: true },
        },
        cors,
      ),
    };
  }
}

async function handleGateway(request: Request, options: GatewayOptions): Promise<Response> {
  const result = await handleGatewayDetailed(request, options);
  return result.response;
}

function landingPage(env: GatewayEnv, version: string, origin: string): string {
  const upstream = (env.NOKEY_BASE_URL ?? DEFAULT_ROUTER).replace(/\/+$/, "");
  const name = env.NOKEY_GATEWAY_NAME ?? "nokey-gateway";
  const keyNote = env.ROUTER_API_KEY
    ? "The server key is injected for callers that send no <code>authorization</code> header."
    : "No server key is configured — callers must send their own <code>authorization</code> header.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0b0f14; color:#e6edf3;
         font:15px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width:760px; padding:32px; }
  h1 { color:#5ad1ff; font-size:20px; margin:0 0 4px; }
  h2 { color:#8b98a5; font-size:13px; text-transform:uppercase; letter-spacing:.08em; margin:28px 0 8px; }
  p.lead { color:#8b98a5; margin:0 0 8px; }
  code { background:#132433; color:#8df0b6; padding:1px 6px; border-radius:4px; }
  pre { background:#0d1720; border:1px solid #22303c; border-radius:8px; padding:16px; overflow:auto; margin:0; }
  a { color:#79b8ff; }
  .badge { display:inline-block; background:#132433; color:#b48cff; border-radius:999px; padding:2px 10px; font-size:12px; }
  ul { padding-left:18px; color:#b6c2cf; }
</style></head>
<body><main>
  <span class="badge">nokey-cli ${version}</span>
  <h1>${name}</h1>
  <p class="lead">A streaming gateway to <a href="${upstream}">nokey-router</a>. Upstream: <code>${upstream}</code></p>
  <p class="lead">${keyNote}</p>

  <h2>Chat (SSE)</h2>
  <pre>curl -N ${origin}/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{"model":"free:auto","stream":true,"messages":[{"role":"user","content":"ping"}]}'</pre>

  <h2>Proxied</h2>
  <ul>${PUBLIC_PATHS.map((p) => `<li><code>${p}</code></li>`).join("")}</ul>

  <h2>Not proxied</h2>
  <p class="lead">Traces, learning, source and forge stay on localhost. Run <code>nokey proxy</code> for the full surface.</p>

  <h2>Use it from the CLI</h2>
  <pre>export NOKEY_BASE_URL=${origin}
nokey</pre>
</main></body></html>`;
}

// ───────────────────────── val entrypoint ─────────────────────────

const VAL_ENV_KEYS = [
  "ROUTER_API_KEY",
  "NOKEY_BASE_URL",
  "NOKEY_ALLOW_ORIGIN",
  "NOKEY_ALLOW",
  "NOKEY_ALLOW_ADMIN",
  "NOKEY_ALLOW_ADMIN_SECRET",
  "NOKEY_FORCE_KEY",
  "NOKEY_REQUIRE_CLIENT_KEY",
  "NOKEY_LANDING",
  "NOKEY_GATEWAY_NAME"
];

function readEnv(key: string): string | undefined {
  const deno = (globalThis as { Deno?: { env?: { get?: (k: string) => string | undefined } } }).Deno;
  const fromDeno = deno?.env?.get?.(key);
  if (fromDeno !== undefined) return fromDeno;
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[key];
}

/** Val Town calls this for every request to the val's URL. */
export default async function nokeyGateway(request: Request): Promise<Response> {
  const env: GatewayEnv = {};
  for (const key of VAL_ENV_KEYS) {
    const value = readEnv(key);
    if (value !== undefined) (env as Record<string, string | undefined>)[key] = value;
  }
  return handleGateway(request, { env, version: GATEWAY_VERSION });
}
