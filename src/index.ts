/**
 * Public API.
 *
 * The CLI is the product, but the pieces are usable on their own: the router
 * client, the session store, the memory engine and the markdown renderer have
 * no terminal dependencies.
 */
export { RouterClient, RouterError, catalogModels, catalogAliases, type ChatRequest, type ChatMessage, type ChatEvent, type Telemetry, type ModelCatalog, type ToolCatalog } from "./router/client.ts";
export { SseParser } from "./router/sse.ts";
export { Session, SessionStore, deriveTitle, type Message, type SessionMeta, type SessionEvent, type SessionSummary } from "./store/session.ts";
export { MemoryBank, MemoryStack, type MemoryItem, type MemoryKind, type MemoryScope } from "./store/memory.ts";
export { ConfigStore, DEFAULT_CONFIG, type Config } from "./store/config.ts";
export { TurnEngine, type EngineEvent, type EngineDeps } from "./core/engine.ts";
export { buildContext, defaultPersona, readProjectInstructions, type ContextPlan, type ContextStats } from "./core/context.ts";
export { extractHeuristic, extractWithModel } from "./core/memory-extract.ts";
export { parseMarkdown, parseInline, extractCodeBlocks, type Block, type Span } from "./render/markdown.ts";
export { renderMarkdown, renderInline, renderPlain } from "./render/markdown-render.ts";
export { highlight, canonicalLang, languageLabel, LANGUAGE_NAMES } from "./render/highlight.ts";
export { THEMES, getTheme, type Theme, type Token } from "./ui/theme.ts";
export { toCells, wrapCells, cellsText, strWidth, type Cell, type Style } from "./util/cells.ts";
export { lineToAnsi, detectColorMode, stripAnsi, type ColorMode } from "./util/ansi.ts";
export { estimateTokens } from "./util/tokens.ts";
export { startProxy } from "./server/proxy.ts";
export { VERSION } from "./version.ts";
