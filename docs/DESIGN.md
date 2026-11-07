# Design notes

A short tour of the internals, aimed at whoever has to change them next.

## Request lifecycle

```
composer ──► TurnEngine.send()
              │
              ├── 1. append the user turn to the session (fsynced event)
              ├── 2. retrieve memory        MemoryStack.retrieve(query, budget)
              ├── 3. build context          buildContext() → system + wire messages
              ├── 4. compact if needed      summarise → append a `summary` node → rebuild
              ├── 5. stream                 RouterClient.stream() → ChatEvent[]
              │        ├── checkpoint every 2 s (crash-safe partial answers)
              │        └── assemble tool-call deltas, telemetry, trace id
              ├── 6. finalise the node      telemetry, token counts, finish reason
              └── 7. learn                  heuristic extraction → memory bank
```

Everything after step 1 is durable: `session.add()` and `session.update()` append
to `events.jsonl` and fsync, then rewrite `meta.json` atomically (temp file +
rename). A power cut mid-stream leaves a valid log whose last message is a
partial answer, and the next launch resumes from it.

## Why a message tree

The obvious design — an array of messages — makes regeneration destructive and
branching impossible. Instead each message stores `parentId`, and `Session.leafId`
selects the active path:

```
        user#1 ─ assistant#2 ─ user#3 ─ assistant#4      ← active path
                    └────── assistant#5                  ← retry sibling
```

Consequences:

- `/retry` appends a sibling of the last assistant message and moves the leaf.
- `/edit n` patches the content of message *n* and sets the leaf to it, so the
  next turn continues from the edited text — the old continuation remains
  reachable.
- `ctrl+←/→` swaps between siblings of the leaf.
- `/tree` is a plain walk of the child map.
- Compaction summaries are ordinary nodes with `role: "summary"`, so a branch
  taken after a summary inherits it with no bookkeeping.

`hide()` writes a tombstone rather than deleting, which keeps the event log
append-only and the audit trail complete.

## Memory scoring

For an item *i* and query tokens *q*:

```
lexical  = Σ_q  idf(q) · tf/(tf + 1.2)          # BM25-lite, tf over item tokens
recency  = 0.5 ^ (age_days / halfLifeDays)      # halfLife 45 by default
score    = (lexical + (pinned ? 0.3 : 0))
           · recency
           · (pinned ? 1.4 : 1)
           · (1 + min(0.5, hits·0.05))
           · kindWeight[kind]                    # preference 1.35 … note 1.0
           · (manual ? 1.2 : 1)
```

A direct lexical hit outranks a pinned-but-unrelated item; a pinned item still
clears the zero filter when nothing matches, which is what makes "always use
pnpm" reliable without dragging stale context into an unrelated session.

`MemoryStack` queries session → project → global with small scope weights and
de-duplicates by text hash, so the same fact stored in two places is injected
once.

Contradiction handling is deliberately narrow: both statements must share a
subject token and differ in polarity (`never`/`not`/`avoid`/`instead of`), with
containment ≥ 0.5. When that fires, the old item is marked `supersededBy` rather
than deleted.

## Context budgeting

`buildContext()` produces:

- `system` — persona, project docs (`KONO.md`, `AGENTS.md`, `CLAUDE.md`), the
  memory block, one runtime line (date, lane, cwd);
- `messages` — the active path from the newest summary node to the leaf;
- `stats` — a breakdown the UI renders as a meter and `/tokens` renders as a table.

Two independent limits:

1. **Soft limit** (`budget · compactAt = 75%`) → `needsCompaction`, which the
   engine satisfies by summarising everything before `keepRecent` turns.
2. **Hard limit** (`budget = window − reserveOutput`) → evict the oldest
   *unpinned* message until it fits. Pinned messages and the final two turns are
   never evicted.

Reasoning tokens are stored and displayed but never sent back to the model: they
are the model's scratch space, and replaying them measurably degrades answers.

## Streaming and failure

`RouterClient.stream()` is an async generator. Retries cover only the cases where
a retry can work (408/409/425/429/5xx and network errors), honour `Retry-After`
in both delta-seconds and HTTP-date forms, and back off with jitter. A `401` or
`403` is terminal and carries a hint about `/key`.

Mid-stream failures never throw: they arrive as `{type:"error", partial:true}` so
the UI keeps whatever was rendered. An idle watchdog aborts when no bytes arrive
for `router.idleMs` (45 s), which is three times the router's 15 s keepalive —
long enough to survive a slow server-side tool round, short enough to notice a
dead endpoint.

SSE parsing (`src/router/sse.ts`) handles frames split anywhere, CRLF/LF, `:
routing` and `: keepalive` comments, the `kono` telemetry chunk and `[DONE]`.

## Rendering

- `src/util/cells.ts` — the cell model, grapheme segmentation, wide-character
  widths (`Intl.Segmenter` + a binary-searched wide table), wrapping with hanging
  indents, and display-exact slicing (a double-width cluster is dropped rather
  than split).
- `src/ui/theme.ts` — semantic tokens (`kw`, `memory`, `tool`, `statusBg`, …) and
  five palettes, including a colour-vision-safe variant and a mono theme.
- `src/render/markdown.ts` — a tolerant block parser; an unterminated fence is
  still a code block, which is exactly what a streaming answer looks like.
- `src/render/highlight.ts` — a stateful scanner: block comments, template
  literals with `${…}`, Python triple quotes, heredocs, regex literals, JSON/CSS
  keys as attributes, diff lines as added/removed.
- `src/ui/transcript.ts` — per-message cache keyed by content version, so a
  keystroke in a 200-message session re-renders one message, not two hundred.
- `src/ui/screen.ts` — alternate screen with row-diffed painting.

## Gateway, two runtimes

`src/server/gateway.ts` is a pure `Request → Response` handler with no imports:
path allowlists, CORS, credential policy, the payload cap and streaming
passthrough all live there.

- `src/server/proxy.ts` adapts it to `node:http` via `Readable.toWeb` and a
  response pump, and widens the allowlist to the full `/v1/*` surface (loopback
  only, admin secret supplied from local config).
- `scripts/build-valtown.ts` inlines the same file into `deploy/valtown/kono-gateway.ts`
  plus an entrypoint that reads env from Deno or Node. The public deployment
  keeps admin routes closed and never injects `x-admin-secret`.

Because Val Town has no build step, the generated val is committed and a test
compares it byte-for-byte with `renderVal()`. That test is the only thing
standing between "fixed locally" and "still broken in production", so it runs
with the rest of the suite.

## Test strategy

80 tests across six files, all offline:

| file | covers |
|:--|:--|
| `test/render.test.ts` | cell widths, wrapping, highlighting, markdown, ANSI quantisation, key decoding |
| `test/store.test.ts` | session DAG, torn-log recovery, export/import, memory scoring/pruning, extraction, config |
| `test/context.test.ts` | system composition, project docs, summary resets, compaction planning, eviction |
| `test/integration.test.ts` | SSE, retries, 401, abort, engine persistence, tool calls, compaction, proxy, CLI |
| `test/gateway.test.ts` | CORS, key injection modes, admin lockdown, payload cap, 502 mapping, incremental streaming, the Node adapter, and the generated Val Town val |
| `test/mock-router.ts` | the stand-in router that makes the above possible |

The interactive UI is verified by replaying its escape stream through a small VT
emulator during development; the diff renderer makes that the only faithful way
to see a frame.
