export const VERSION = "1.0.0";

/**
 * Hosted deployment of the same gateway handler `kono proxy` runs locally:
 * streaming chat with CORS and server-side key handling.
 */
export const HOSTED_GATEWAY = "https://kono.val.run";

export const HELP_TEXT = `kono ${VERSION} — a stateful, colour-coded terminal chat for nokey-router

USAGE
  kono                       start the interactive TUI (resumes the last session)
  kono "explain this repo"   one-shot: stream an answer to stdout
  kono -p "prompt" --json    scriptable output with telemetry
  echo "prompt" | kono       read the prompt from stdin
  kono <command>             session, memory, model and ops utilities

COMMANDS
  sessions list                 recent sessions with message/token counts
  sessions show <id>            print a session as markdown
  sessions export <id> [path]   export JSON (events + tree)
  sessions import <file>        re-import an exported session
  sessions rm <id>              delete a session
  sessions search <query>       full-text search across every session
  memory list|add|rm|search     manage the durable memory bank
  memory stats|export|import    inspect or move memories
  models [--json]               catalogue from /v1/models
  tools [--json]                the router's executable tool plane
  tools run <name> [json]       execute one tool
  config get|set|path|init      read or change settings
  doctor                        connectivity, auth and storage checks
  proxy [--port 8787]           CORS-enabled local gateway to the router
  gateway                       print the hosted gateway URL
  export <id> [path]            markdown export
  init                          write a KONO.md project-instructions file

HOSTED
  https://kono.val.run          the same gateway, hosted (see docs/DEPLOY-VALTOWN.md)
                                use it with KONO_BASE_URL=https://kono.val.run

FLAGS
  --model <lane>       free:auto (default), free:fast, free:smart, free:code, free:reasoning
  --session <id>       resume a specific session (prefix match)
  --continue           resume the most recent session (default in the TUI)
  --system <text>      extra system instruction for this run
  --tools              let the router execute its own tools for this turn
  --reasoning          stream the reasoning channel to stderr
  --json               machine-readable output (print mode)
  --key <key>          ROUTER_API_KEY for this run
  --base <url>         router base URL for this run
  --theme <name>       midnight | aurora | accessible | daylight | mono
  --home <dir>         override the state directory (default ~/.kono)
  --no-color           disable colour entirely
  --version, --help

ENVIRONMENT
  ROUTER_API_KEY / KONO_API_KEY     bearer token for the router
  KONO_ADMIN_SECRET                 x-admin-secret for admin routes
  KONO_BASE_URL                     override the router URL
  KONO_MODEL, KONO_THEME           defaults
  KONO_COLOR                        auto | truecolor | 256 | 16 | none
  KONO_HOME                         state directory
  KONO_DEBUG                        verbose diagnostics on stderr

INSIDE THE TUI
  ?  help      ctrl+k  palette     ctrl+s  sessions   ctrl+m  memory
  ctrl+o model ctrl+t  themes      ctrl+f  search     ctrl+g  regenerate
  esc stop     ctrl+c  twice quits  ctrl+left/right   switch branch

Learn more: https://nokey-router.ziggyware.deno.net`;
