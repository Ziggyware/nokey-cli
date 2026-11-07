#!/usr/bin/env node
/**
 * Build the single-file Val Town val from the shared gateway core.
 *
 * Val Town vals are single files, so the core is inlined verbatim: the same
 * `handleGateway` that the local proxy runs is what gets deployed. Generated
 * output is committed (`deploy/valtown/nokey-gateway.ts`) because Val Town has
 * no build step — `test/gateway.test.ts` fails if the two ever drift.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
export const CORE_PATH = join(repoRoot, "src", "server", "gateway.ts");
export const VAL_PATH = join(repoRoot, "deploy", "valtown", "nokey-gateway.ts");

/** Environment variables the val reads on every request. */
export const VAL_ENV_KEYS = [
  "ROUTER_API_KEY",
  "NOKEY_BASE_URL",
  "NOKEY_ALLOW_ORIGIN",
  "NOKEY_ALLOW",
  "NOKEY_ALLOW_ADMIN",
  "NOKEY_ALLOW_ADMIN_SECRET",
  "NOKEY_FORCE_KEY",
  "NOKEY_REQUIRE_CLIENT_KEY",
  "NOKEY_LANDING",
  "NOKEY_GATEWAY_NAME",
];

const HEADER = `/**
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

`;

const WRAPPER = `
// ───────────────────────── val entrypoint ─────────────────────────

const VAL_ENV_KEYS = ${JSON.stringify(VAL_ENV_KEYS, null, 2)};

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
`;

/** Strip module syntax so the core can live inside another file. */
export function inlineCore(source: string): string {
  return source
    .split("\n")
    .map((line) => line.replace(/^export (const|let|function|async function|interface|type) /, "$1 "))
    .filter((line) => !/^import\s/.test(line))
    .join("\n");
}

export function renderVal(): string {
  const core = readFileSync(CORE_PATH, "utf8");
  const banner = `// ───────────────────── shared gateway core ─────────────────────\n`;
  const body = inlineCore(core).replace(/^\/\*\*[\s\S]*?\*\/\n/, "");
  return `${HEADER}${banner}${body.trimEnd()}\n${WRAPPER}`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const output = renderVal();
  mkdirSync(dirname(VAL_PATH), { recursive: true });
  writeFileSync(VAL_PATH, output);
  const lines = output.split("\n").length;
  console.log(`wrote ${VAL_PATH} (${lines} lines)`);
}
