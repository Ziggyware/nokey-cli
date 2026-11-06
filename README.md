# nokey

A stateful, colour-coded terminal chat for [nokey-router](https://nokey-router.ziggyware.deno.net) — streaming answers, syntax highlighting, a durable memory engine and a real session DAG, with zero runtime dependencies.

```
◈ nokey Explain how the router stre…  ●  ⛁ free:auto   ✦ 12   ▕████░░░░░░▏ 38%   ⌗ 0mw4o0
  ● assistant · free:auto   #2
    Here's a minimal streaming client for **nokey-router**.

    ## Why it works
    The router sends `: routing` heartbeats until an upstream commits, so the
    client must not treat comments as errors.

    ▎ typescript · client.ts
    ▎  1 │ export async function* chat(prompt: string) {
    ▎  2 │   const res = await fetch("https://…/v1/chat/completions", {
    ▎  3 │     method: "POST",
    ▎  4 │   });
    ▎  5 │   return res.body; // chunks arrive as SSE data frames
    ▎  6 │ }

    ┌────────────┬─────────────────┬──────────────┐
    │ lane       │ best for        │ typical ttft │
    ├────────────┼─────────────────┼──────────────┤
    │ free:fast  │ short answers   │       400 ms │
    │ free:smart │ reasoning       │       900 ms │
    └────────────┴─────────────────┴──────────────┘
    ⚡ 47ms · ⏱ 3.00s · 70.0 tok/s · 64→210 · 1 attempt · trace 00f067aa0b
────────────────────────────────────────────────────────────────────────────────
 ❯ ask anything, or type / for commands
    enter  send   alt+enter  newline   /  commands   ctrl+k  palette
 ❯ ready                                                    11.2k/128k · ? help
```

## Why this exists

`nokey-router` is deliberately forgiving: it races lanes, falls back exhaustively, and answers 200 even when degraded. That makes it pleasant through `curl` and painful through a chat client — heartbeats look like errors, telemetry hides in headers, and a long session silently blows the context window.

This CLI is the client that takes the router at its word:

- **Streams the truth.** `: routing` heartbeats, `delta.reasoning_content`, tool-call deltas, in-band `nokey` telemetry, `X-Nokey-Degraded`, trace ids — all surfaced, none swallowed.
- **Remembers.** A scored memory bank survives sessions and is injected on a token budget, never wholesale.
- **Never loses history.** Messages form a tree; edits and regenerations create siblings you can walk with `ctrl+←/→`.
- **Survives a crash.** Every turn is appended to an fsynced event log, so `kill -9` costs you at most the in-flight answer.

## Install

```bash
git clone <this repo> nokey-cli && cd nokey-cli
node bin/nokey.js --help          # no install step: Node ≥ 22.6 strips types directly
```

Optionally link it as `nokey`:

```bash
npm link            # or: npm install -g .
nokey
```

You need a router API key:

```bash
export ROUTER_API_KEY=…           # or NOKEY_API_KEY
# or, inside the TUI:
/key <ROUTER_API_KEY>
```

Keys live in `~/.nokey/config.json` with `0600` permissions, are never written to session logs, and are masked everywhere they are displayed (`nok_…3456`).

## Use

```bash
nokey                              # interactive TUI (resumes your last session)
nokey "explain this stack trace"   # one-shot, streams to stdout
echo "summarise this diff" | nokey # stdin works too
nokey -p "list risks" --json       # machine-readable: content + telemetry
nokey -p "review src/app.ts" --model free:code --reasoning
```

Utilities, all scriptable:

```bash
nokey sessions list                # id, time, messages, tokens, title
nokey sessions search bayesian     # full-text across every session
nokey sessions export <id> out.json
nokey memory list                  # every durable fact, with scope and kind
nokey memory add "deploys are Thursdays" --pin
nokey models --json                # the live catalogue from /v1/models
nokey tools                        # the router's executable tool plane
nokey tools run calculate '{"expression":"2+2"}'
nokey doctor                       # connectivity, auth, storage
nokey proxy --port 8787            # CORS gateway for browsers and other tools
```

### Keys inside the TUI

| keys | action |
|:--|:--|
| `enter` / `alt+enter` | send / newline |
| `tab` | complete a slash command, else expand reasoning |
| `ctrl+k` `ctrl+s` `ctrl+m` `ctrl+o` `ctrl+t` `ctrl+f` | palette · sessions · memory · model · theme · search |
| `ctrl+g` | regenerate as a new branch |
| `ctrl+←` `ctrl+→` | walk sibling branches |
| `pgup`/`pgdn`, `alt+↑/↓`, `ctrl+home`/`ctrl+end` | scroll |
| `esc` | close overlay · stop generation · clear input |
| `ctrl+c` | stop generation, then clear, then quit (twice) |
| `?` | help sheet |

### Commands

38 commands, all fuzzy-searchable from `ctrl+k`. The ones that matter:

| command | what it does |
|:--|:--|
| `/model free:smart` | switch lane or exact model (`/model` alone opens the catalogue) |
| `/retry` | regenerate as a sibling branch — the old answer stays in the tree |
| `/edit <n> <text>` | rewrite message *n* and re-run from there |
| `/branch [n]` | fork the conversation at message *n* |
| `/tree` | draw the message tree with the active path marked |
| `/compact` | fold older turns into a summary node now |
| `/tokens` | context budget breakdown: user / assistant / tool / reasoning |
| `/remember …` · `/forget …` · `/memory` | curate durable memory |
| `/pin <n>` | keep message *n* out of compaction |
| `/find <q> --all` | search this session or everything |
| `/copy [n]` | copy the last code block (or message *n*) via pbcopy/OSC 52 |
| `/feedback up` | rate the last answer; joins the router's learning loop by trace id |
| `/tools` · `/tool <name> {json}` | inspect and execute the router tool plane |
| `/theme aurora` · `/reasoning expanded` · `/verbose` | make it yours |
| `/export md` · `/import <file>` | move conversations in and out |

## How the state works

### Sessions are event logs, conversations are trees

```
~/.nokey/sessions/<id>/
  meta.json      rewritten atomically (title, model, leaf, counts)
  events.jsonl   append-only, fsynced per turn
  memory.json    session-scoped memories
```

Every message names its parent. The *active leaf* selects which path is the conversation, so `/retry` and `/edit` add siblings instead of destroying text, and `ctrl+←/→` flips between them:

```
● you · what does this error mean
  ● assistant · it's a CORS failure        ⑂ 2 branches
  ○ assistant · it's a TLS failure
```

Hiding (`/delete`, `/undo`) writes a tombstone: the log keeps the audit trail, the tree stops showing it.

### Memory that earns its place

Three scopes, merged on read:

| scope | file | lifetime |
|:--|:--|:--|
| `session` | `sessions/<id>/memory.json` | this conversation |
| `project` | `<cwd>/.nokey/memory.json` | this repository |
| `global` | `~/.nokey/memory.json` | you, everywhere |

Extraction is deterministic by default (`memory.extract = "heuristic"`): sentence-level patterns catch preferences, decisions, constraints, identities and open tasks, then near-duplicates (token Jaccard ≥ 0.72) merge and contradictions supersede. Set `memory.extract = "llm"` to have a cheap lane propose candidates — they pass through exactly the same validation, so a bad model cannot corrupt the bank.

Retrieval is a BM25-lite lexical score × exponential recency decay × pin/hit boosts, trimmed to `memory.injectTokens` (900 by default) and `injectTopK` (8). An irrelevant session injects nothing, because zero-scoring items are simply not included.

```
✦ remembered: prefers pnpm over npm for installs          (+1)
```

Inspect and correct it any time with `ctrl+m`: `⏎` pins, `d` forgets.

### Context that fits, honestly

`/tokens` shows the real budget:

| bucket | tokens | share |
|:--|--:|--:|
| user | 2.1k | 18% |
| assistant | 8.9k | 76% |
| tool results | 640 | 6% |
| **total sent** | **11.6k** | of 128k |

When history crosses `context.compactAt` (75%), the oldest turns are summarised into a `summary` node *in the tree*. The context builder resets its window at the newest summary, so branches inherit the summary naturally and nothing is hidden outside the log. If the summariser call fails, a structural digest is used and labelled as such — the turn still proceeds.

As a last resort the builder evicts the oldest *unpinned* message; pinned messages and the most recent tail always survive.

### Project instructions

Drop a `NOKEY.md` (or `AGENTS.md`, `CLAUDE.md`) in a directory and it is injected as project context for every session started there. `nokey init` scaffolds one.

## Configuration

`~/.nokey/config.json`, or `nokey config get|set <section.key> <value>`.

| key | default | notes |
|:--|:--|:--|
| `router.baseUrl` | `https://nokey-router.ziggyware.deno.net` | |
| `router.apiKey` | — | `0600`, masked in output |
| `router.retries` / `idleMs` | `2` / `45000` | idle watchdog vs. the 15 s keepalive |
| `model.default` | `free:auto` | `free:fast` `free:smart` `free:code` `free:reasoning` |
| `context.windowTokens` | `128000` | overridden automatically for known model families |
| `context.compaction` | `auto` | `auto` · `manual` · `off` |
| `context.compactAt` | `0.75` | trigger ratio |
| `context.keepRecent` | `12` | turns never summarised |
| `memory.extract` | `heuristic` | `heuristic` · `llm` · `off` |
| `memory.injectTopK` / `injectTokens` | `8` / `900` | injection budget |
| `memory.halfLifeDays` | `45` | recency decay |
| `ui.theme` | `midnight` | `midnight` · `aurora` · `accessible` · `daylight` · `mono` |
| `ui.showReasoning` | `collapsed` | `collapsed` · `expanded` · `hidden` |
| `ui.colorMode` | `auto` | truecolor → 256 → 16 → none auto-detected |

Environment overrides: `ROUTER_API_KEY`, `NOKEY_API_KEY`, `NOKEY_ADMIN_SECRET`, `NOKEY_BASE_URL`, `NOKEY_MODEL`, `NOKEY_THEME`, `NOKEY_COLOR`, `NOKEY_HOME`, `NOKEY_DEBUG`.

## Design notes

- **Cells, not ANSI strings.** Everything renders into styled cells (`src/util/cells.ts`); wrapping, truncation and wide-character alignment work on real column widths, and escapes are emitted once at paint time. That is why CJK, emoji and tables stay aligned, and why the renderer is testable without a terminal.
- **Differential painting.** Only changed rows are rewritten (`src/ui/screen.ts`), so streaming is cheap even over SSH.
- **A real tokenizer for code.** `src/render/highlight.ts` is a stateful scanner with 28 language definitions — block comments, template literals, Python triple-quoted strings and heredocs keep state across lines.
- **Theme tokens everywhere.** No hex literal appears in a renderer; swapping `ui.theme` re-colours the entire UI, including the syntax palette, at runtime.
- **One turn pipeline.** The TUI and `-p` mode share `TurnEngine`, so memory, compaction, telemetry and persistence behave identically in both.
- **Zero runtime dependencies.** Node ≥ 22.6 runs the TypeScript directly; `npm run build` exists for older runtimes.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the request lifecycle and the scoring formulas.

## Development

```bash
npm test           # 61 tests: cells, highlight, markdown, memory, sessions, context, streaming, retries, CLI
npm run typecheck  # strict tsc, erasable-syntax-only (runs without a build)
npm run mock       # a local stand-in router on :8799
NOKEY_BASE_URL=http://127.0.0.1:8799 NOKEY_API_KEY=test npm start
```

The mock implements SSE frames, routing heartbeats, `nokey` telemetry, degraded mode, 429-then-succeed and the tool plane, so the whole stack is testable offline.

## Troubleshooting

| symptom | cause |
|:--|:--|
| `Unauthorized (401) — check ROUTER_API_KEY` | no/invalid key: `/key <value>` |
| spinner stalls, `routing …` in the footer | the router is racing lanes; it heartbeats every 15 s by design |
| `degraded` badge | every lane was exhausted; the answer is real but unranked |
| `context trimmed` notice | history exceeded the window and compaction was off |
| colours look wrong | `nokey config set ui.colorMode 256`, or `NO_COLOR=1` |

## License

MIT.
