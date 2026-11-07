# Deploying the gateway to Val Town

## What gets deployed — and what cannot

Val Town runs stateless HTTP functions, so the **TUI itself cannot be hosted
there** (there is no terminal, no `~/.kono`, no long-lived process). Sessions,
memory and history belong on the machine you type on, by design.

What *is* deployable is the **gateway**: the same HTTP surface `kono proxy` runs
locally, on a public URL. That buys you three things:

- **A stable origin** for browsers and other tools, with CORS already correct.
- **Server-side key handling**, so a front-end never holds `ROUTER_API_KEY`.
- **Edge streaming** — the val passes SSE bytes through as they arrive instead of
  buffering, which is the usual way a proxy quietly breaks a chat stream.

The val and the local proxy execute **the identical handler**
(`src/server/gateway.ts`). Only the adapter differs: `node:http` locally, the
platform's `Request`/`Response` on Val Town.

```
kono (local TUI)  ──HTTP──►  val: gateway  ──HTTPS──►  nokey-router
   ~/.kono                    streaming, CORS, key
```

## 1. Create the val

1. In Val Town, **New Val → HTTP**.
2. Name it `kono-gateway`.
3. Replace the contents with [`deploy/valtown/kono-gateway.ts`](../deploy/valtown/kono-gateway.ts)
   (415 lines, no imports — it is generated to be paste-ready).
4. Save. The editor shows the val's URL, of the form
   `https://kono.val.run`.

That file is generated — never hand-edit it. Change `src/server/gateway.ts` and
run `npm run build:valtown`. A test fails if the committed copy drifts.

## 2. Configure it

Add environment variables in the val's settings. Only the first is required:

| variable | purpose |
|:--|:--|
| `ROUTER_API_KEY` | the router key the gateway signs with |
| `KONO_REQUIRE_CLIENT_KEY` | `1` = refuse callers who send no `authorization` header. **Recommended if the URL is public**: without it, anyone who finds the URL spends your router quota |
| `KONO_BASE_URL` | point at a different router origin (defaults to the public one) |
| `KONO_ALLOW_ORIGIN` | lock CORS to one origin instead of `*` |
| `KONO_ALLOW` | extra path prefixes to expose, comma-separated |
| `KONO_GATEWAY_NAME` | label shown on the landing page |
| `KONO_ALLOW_ADMIN` | `1` exposes traces/learning/source. Leave off unless you know why |

Two shapes make sense:

**Private gateway** (your own key, unlisted URL): set `ROUTER_API_KEY`, leave
`KONO_REQUIRE_CLIENT_KEY` unset.

**Shared gateway** (you publish the URL): set `KONO_REQUIRE_CLIENT_KEY=1` and
either keep `ROUTER_API_KEY` as a fallback for yourself or drop it entirely.

## 3. Verify the deployment

The smoke check exists precisely because serverless streaming fails quietly — a
buffering proxy still answers `200`.

```bash
npm run check:gateway -- https://kono.val.run
```

```
✔ healthz                    200 in 57ms · upstream https://nokey-router.ziggyware.deno.net · key configured
✔ cors preflight             204 · allow-origin *
✔ catalogue                  200 in 19ms · 5 models · first free:auto
✔ streaming chat             200 · ttfb 15ms of 2989ms · 18706B · [DONE] · attempts 1
✔ admin lockdown             403 on /v1/traces (blocked)

https://… is healthy · export KONO_BASE_URL=https://… and run `kono`
```

Read the `ttfb` column carefully: if the first byte arrives only at the end of
the stream, the platform is buffering and the deployment is not usable for chat.

Pass `--key nok_…` to test a key-guarded gateway (or set `ROUTER_API_KEY` in the
environment rather than on the command line).

## 4. Point the CLI at it

```bash
export KONO_BASE_URL=https://kono.val.run
kono                              # TUI
kono -p "hello" --json            # scripting
```

or persist it:

```bash
kono config set router.baseUrl https://kono.val.run
kono config set router.requireClientKey true   # only if KONO_REQUIRE_CLIENT_KEY=1
```

Sessions, memory and history stay in `~/.kono` — the val is transport only.

## Security model

| surface | deployed | local `kono proxy` |
|:--|:--|:--|
| `POST /v1/chat/completions` | ✅ streamed | ✅ |
| `GET /v1/models`, `/v1/endpoints`, `/health` | ✅ | ✅ |
| `GET /v1/tools`, `POST /v1/tools/execute` | ✅ | ✅ |
| `POST /v1/images/generations` | ✅ | ✅ |
| `/v1/community/*` | ✅ | ✅ |
| `/v1/traces*`, `/v1/source*`, `/v1/learning*`, `/v1/tools/forge`, `/v1/probe`, `/v1/sync`, `/v1/resurrect` | ⛔ `403` | ✅ |
| `x-admin-secret` | never injected, not forwarded unless `KONO_ALLOW_ADMIN=1` **and** `KONO_ALLOW_ADMIN_SECRET=1` | injected from local config |
| request bodies | capped at 2 MB | capped at 2 MB |

Other deliberate choices:

- **Keys are never echoed.** `/healthz` reports `keyConfigured: true|false`, never the value; the landing page names no credential.
- **Caller credentials are preferred over the deployment's**, so a shared gateway lets people use their own key (`KONO_FORCE_KEY=1` flips that).
- **No session state on the platform.** The val holds nothing between requests, so there is nothing to leak or expire.
- **`/healthz` and `/`** are the only non-proxied endpoints, and both are read-only.

## Operating notes

- **Timeouts.** Long generations can outlive a serverless invocation. The router
  degrades gracefully, and the CLI reports a truncated answer rather than a
  silent failure; for very long turns prefer the local proxy.
- **Cost.** Each request is one invocation. Streaming chat keeps an invocation
  open for the duration of the answer.
- **Updating.** Edit `src/server/gateway.ts` → `npm run build:valtown` → paste
  the regenerated file over the val. The drift test (`test/gateway.test.ts`)
  keeps the repo honest between deploys.
- **Rollback.** Val Town keeps version history per val; revert from the editor.

## Troubleshooting

| symptom | cause |
|:--|:--|
| `401 client_key_required` | the val sets `KONO_REQUIRE_CLIENT_KEY=1`; send `authorization: Bearer …` or set it in the CLI config |
| `401 Unauthorized` from the router | `ROUTER_API_KEY` missing on the val |
| `403 admin_route_blocked` | you asked for a trace/learning route; run `kono proxy` locally for those |
| chat returns one big blob at the end | the platform buffered the stream; check `ttfb` with `check:gateway` |
| `502 upstream_unreachable` | `KONO_BASE_URL` is wrong or the router is down |
| CORS errors in a browser | set `KONO_ALLOW_ORIGIN` to your exact origin (including scheme) |
