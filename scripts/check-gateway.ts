#!/usr/bin/env node
/**
 * Post-deploy smoke check for a hosted nokey gateway.
 *
 *   node scripts/check-gateway.ts https://your-val.web.val.run
 *   node scripts/check-gateway.ts https://your-val.web.val.run --key nok_…
 *
 * Verifies the things that break silently in a serverless deployment: CORS
 * preflight, key injection, streaming (a buffered proxy still returns 200 but
 * never streams), and that admin routes stayed closed.
 *
 * Exit code 0 = healthy, 1 = something to fix.
 */
const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--"));
const keyIndex = args.indexOf("--key");
const key = keyIndex >= 0 ? args[keyIndex + 1] : process.env.ROUTER_API_KEY;

if (!url) {
  console.error("usage: node scripts/check-gateway.ts <gateway-url> [--key <router-key>]");
  process.exit(2);
}
const base = url.replace(/\/+$/, "");

type Check = { name: string; ok: boolean; detail: string };
const results: Check[] = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name.padEnd(26)} ${detail}`);
};

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - start };
}

async function main(): Promise<void> {
  // 1. healthz — the gateway's own view of itself.
  try {
    const { value: res, ms } = await timed(() => fetch(`${base}/healthz`));
    const body = (await res.json()) as Record<string, unknown>;
    record("healthz", res.ok && body.ok === true, `${res.status} in ${ms}ms · upstream ${body.upstream} · key ${body.keyConfigured ? "configured" : "MISSING"}`);
    if (body.keyConfigured !== true) {
      console.log("  → set ROUTER_API_KEY on the val, or every chat will 401");
    }
  } catch (err) {
    record("healthz", false, (err as Error).message);
    return;
  }

  // 2. CORS preflight.
  try {
    const res = await fetch(`${base}/v1/chat/completions`, { method: "OPTIONS" });
    const allow = res.headers.get("access-control-allow-origin");
    record("cors preflight", res.status === 204 && allow !== null, `${res.status} · allow-origin ${allow ?? "none"}`);
  } catch (err) {
    record("cors preflight", false, (err as Error).message);
  }

  // 3. Catalogue.
  try {
    const { value: res, ms } = await timed(() =>
      fetch(`${base}/v1/models`, key ? { headers: { authorization: `Bearer ${key}` } } : undefined),
    );
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const count = Array.isArray(body.data) ? body.data.length : 0;
    record("catalogue", res.ok && count > 0, `${res.status} in ${ms}ms · ${count} models${body.data?.[0]?.id ? ` · first ${body.data[0].id}` : ""}`);
  } catch (err) {
    record("catalogue", false, (err as Error).message);
  }

  // 4. Streaming chat — the check that matters most.
  try {
    const start = Date.now();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: "free:auto",
        stream: true,
        max_tokens: 24,
        messages: [{ role: "user", content: "Reply with the single word: gateway." }],
      }),
    });
    if (!res.body) throw new Error("no response body");
    const ct = res.headers.get("content-type") ?? "";
    let bytes = 0;
    let firstAt = 0;
    let sawDone = false;
    let text = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!firstAt) firstAt = Date.now() - start;
      bytes += value?.byteLength ?? 0;
      text += decoder.decode(value, { stream: true });
      if (text.includes("[DONE]")) sawDone = true;
    }
    const total = Date.now() - start;
    const streaming = firstAt > 0 && firstAt <= total;
    record(
      "streaming chat",
      res.ok && ct.includes("event-stream") && sawDone,
      `${res.status} · ttfb ${firstAt}ms of ${total}ms · ${bytes}B · ${sawDone ? "[DONE]" : "no [DONE]"} · attempts ${res.headers.get("x-nokey-attempts") ?? "?"}`,
    );
    if (!streaming) record("stream is buffered", false, "first byte arrived after the stream ended");
    if (res.headers.get("content-type")?.includes("application/json")) {
      record("streaming chat", false, "gateway returned JSON — it may be buffering the stream");
    }
  } catch (err) {
    record("streaming chat", false, (err as Error).message);
  }

  // 5. Admin lockdown.
  try {
    const res = await fetch(`${base}/v1/traces`);
    record("admin lockdown", res.status === 403, `${res.status} on /v1/traces ${res.status === 403 ? "(blocked)" : "(EXPOSED)"}`);
  } catch (err) {
    record("admin lockdown", false, (err as Error).message);
  }

  const failed = results.filter((r) => !r.ok);
  console.log("");
  if (failed.length === 0) {
    console.log(`${base} is healthy · export NOKEY_BASE_URL=${base} and run \`nokey\``);
  } else {
    console.log(`${failed.length} check(s) failed: ${failed.map((f) => f.name).join(", ")}`);
    process.exitCode = 1;
  }
}

void main();
