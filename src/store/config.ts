/**
 * Configuration.
 *
 * Layered: built-in defaults → config.json → environment → CLI flags. The API
 * key is never written to the session log, never echoed, and the config file is
 * created with 0600 permissions.
 */
import { readJsonSafe, writeJson } from "../util/fsx.ts";
import { paths } from "./paths.ts";
import { THEME_NAMES } from "../ui/theme.ts";

export type ReasoningDisplay = "collapsed" | "expanded" | "hidden";
export type ExtractionMode = "heuristic" | "llm" | "off";
export type CompactionMode = "auto" | "manual" | "off";
export type ColorSetting = "auto" | "truecolor" | "256" | "16" | "none";

export interface Config {
  version: number;
  router: {
    baseUrl: string;
    apiKey: string;
    adminSecret: string;
    timeoutMs: number;
    idleMs: number;
    retries: number;
  };
  model: {
    default: string;
    fast: string;
    smart: string;
    code: string;
    reasoning: string;
    temperature: number | null;
    maxTokens: number | null;
  };
  session: {
    titleSource: "first-message" | "auto" | "manual";
    resumeLast: boolean;
    maxSessions: number;
    branchOnEdit: boolean;
  };
  context: {
    windowTokens: number;
    reserveOutputTokens: number;
    compaction: CompactionMode;
    compactAt: number;
    keepRecent: number;
    summarizerModel: string;
  };
  memory: {
    enabled: boolean;
    extract: ExtractionMode;
    extractorModel: string;
    maxItems: number;
    injectTopK: number;
    injectTokens: number;
    halfLifeDays: number;
    useProjectMemory: boolean;
    readProjectDocs: boolean;
  };
  ui: {
    theme: string;
    density: "comfortable" | "compact";
    lineNumbers: boolean;
    codeWrap: boolean;
    showReasoning: ReasoningDisplay;
    showTelemetry: boolean;
    showTokenBar: boolean;
    showTimestamps: boolean;
    colorMode: ColorSetting;
    animations: boolean;
    bellOnDone: boolean;
  };
  tools: {
    auto: boolean;
    flavor: "openai" | "openai-strict" | "anthropic" | "gemini";
  };
  privacy: {
    sendFeedback: boolean;
    storeReasoning: boolean;
    redactSecrets: boolean;
  };
}

export const DEFAULT_CONFIG: Config = {
  version: 1,
  router: {
    baseUrl: "https://nokey-router.ziggyware.deno.net",
    apiKey: "",
    adminSecret: "",
    timeoutMs: 180_000,
    idleMs: 45_000,
    retries: 2,
  },
  model: {
    default: "free:auto",
    fast: "free:fast",
    smart: "free:smart",
    code: "free:code",
    reasoning: "free:reasoning",
    temperature: null,
    maxTokens: null,
  },
  session: {
    titleSource: "first-message",
    resumeLast: true,
    maxSessions: 500,
    branchOnEdit: true,
  },
  context: {
    windowTokens: 128_000,
    reserveOutputTokens: 4_096,
    compaction: "auto",
    compactAt: 0.75,
    keepRecent: 12,
    summarizerModel: "free:fast",
  },
  memory: {
    enabled: true,
    extract: "heuristic",
    extractorModel: "free:fast",
    maxItems: 400,
    injectTopK: 8,
    injectTokens: 900,
    halfLifeDays: 45,
    useProjectMemory: true,
    readProjectDocs: true,
  },
  ui: {
    theme: "midnight",
    density: "comfortable",
    lineNumbers: true,
    codeWrap: true,
    showReasoning: "collapsed",
    showTelemetry: true,
    showTokenBar: true,
    showTimestamps: false,
    colorMode: "auto",
    animations: true,
    bellOnDone: false,
  },
  tools: {
    auto: false,
    flavor: "openai",
  },
  privacy: {
    sendFeedback: true,
    storeReasoning: true,
    redactSecrets: true,
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Merge known keys only, so a corrupted config can never inject garbage. */
export function mergeConfig(base: Config, patch: unknown): Config {
  // Always clone: callers mutate the result, and returning `base` would let a
  // single `set` rewrite the in-process defaults for everything after it.
  if (!isPlainObject(patch)) return coerceConfig(structuredClone(base));
  const out: Config = structuredClone(base);
  for (const [section, value] of Object.entries(patch)) {
    if (!isPlainObject(value)) continue;
    if (!(section in out)) continue;
    const target = out[section as keyof Config] as unknown as Record<string, unknown>;
    for (const [key, v] of Object.entries(value)) {
      if (key in target && v !== undefined) target[key] = v;
    }
  }
  return coerceConfig(out);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function coerceConfig(cfg: Config): Config {
  const c = cfg;
  c.version = 1;
  c.router.baseUrl = String(c.router.baseUrl || DEFAULT_CONFIG.router.baseUrl).trim();
  if (!/^https?:\/\//i.test(c.router.baseUrl)) c.router.baseUrl = `https://${c.router.baseUrl}`;
  c.router.timeoutMs = clamp(Number(c.router.timeoutMs) || 180_000, 5_000, 900_000);
  c.router.idleMs = clamp(Number(c.router.idleMs) || 45_000, 5_000, 300_000);
  c.router.retries = clamp(Math.trunc(Number(c.router.retries) || 0), 0, 8);
  c.model.default = String(c.model.default || "free:auto").trim();
  c.context.windowTokens = clamp(Number(c.context.windowTokens) || 128_000, 2_000, 2_000_000);
  c.context.reserveOutputTokens = clamp(Number(c.context.reserveOutputTokens) || 4_096, 256, 128_000);
  c.context.compactAt = clamp(Number(c.context.compactAt) || 0.75, 0.3, 0.98);
  c.context.keepRecent = clamp(Math.trunc(Number(c.context.keepRecent) || 12), 2, 200);
  c.memory.maxItems = clamp(Math.trunc(Number(c.memory.maxItems) || 400), 10, 10_000);
  c.memory.injectTopK = clamp(Math.trunc(Number(c.memory.injectTopK) || 8), 0, 50);
  c.memory.injectTokens = clamp(Math.trunc(Number(c.memory.injectTokens) || 900), 0, 8_000);
  c.memory.halfLifeDays = clamp(Number(c.memory.halfLifeDays) || 45, 1, 3650);
  if (!THEME_NAMES.includes(c.ui.theme)) c.ui.theme = DEFAULT_CONFIG.ui.theme;
  c.ui.showReasoning = ["collapsed", "expanded", "hidden"].includes(c.ui.showReasoning) ? c.ui.showReasoning : "collapsed";
  c.memory.extract = ["heuristic", "llm", "off"].includes(c.memory.extract) ? c.memory.extract : "heuristic";
  c.context.compaction = ["auto", "manual", "off"].includes(c.context.compaction) ? c.context.compaction : "auto";
  c.session.maxSessions = clamp(Math.trunc(Number(c.session.maxSessions) || 500), 1, 10_000);
  return c;
}

export interface EnvOverrides {
  NOKEY_BASE_URL?: string;
  NOKEY_API_KEY?: string;
  NOKEY_ADMIN_SECRET?: string;
  NOKEY_MODEL?: string;
  NOKEY_THEME?: string;
  NOKEY_COLOR?: string;
  NO_COLOR?: string;
  NOKEY_IDLE_MS?: string;
}

export class ConfigStore {
  readonly path: string;
  #config: Config;
  #warnings: string[] = [];

  constructor(home?: string, env: NodeJS.ProcessEnv = process.env) {
    this.path = paths(home ?? undefined).config;
    const loaded = readJsonSafe<unknown>(this.path);
    this.#config = coerceConfig(mergeConfig(DEFAULT_CONFIG, loaded));
    this.#applyEnv(env);
  }

  #applyEnv(env: NodeJS.ProcessEnv): void {
    const e = env as EnvOverrides;
    if (e.NOKEY_BASE_URL) this.#config.router.baseUrl = e.NOKEY_BASE_URL;
    if (e.NOKEY_API_KEY) this.#config.router.apiKey = e.NOKEY_API_KEY;
    if (e.NOKEY_ADMIN_SECRET) this.#config.router.adminSecret = e.NOKEY_ADMIN_SECRET;
    if (e.NOKEY_MODEL) this.#config.model.default = e.NOKEY_MODEL;
    if (e.NOKEY_THEME) this.#config.ui.theme = e.NOKEY_THEME;
    if (e.NOKEY_COLOR) this.#config.ui.colorMode = e.NOKEY_COLOR as ColorSetting;
    if (e.NO_COLOR && !e.NOKEY_COLOR) this.#config.ui.colorMode = "none";
    if (e.NOKEY_IDLE_MS) this.#config.router.idleMs = Number(e.NOKEY_IDLE_MS) || this.#config.router.idleMs;
    this.#config = coerceConfig(this.#config);
  }

  get value(): Config {
    return this.#config;
  }

  get warnings(): string[] {
    return [...this.#warnings];
  }

  exists(): boolean {
    return readJsonSafe(this.path) !== null;
  }

  save(): void {
    writeJson(this.path, this.#config, 0o600);
  }

  /** Apply a dot-path patch: `set("ui.theme", "aurora")`. */
  set(dotPath: string, raw: string): void {
    const parts = dotPath.split(".").filter(Boolean);
    if (parts.length !== 2) throw new Error(`Expected section.key, got "${dotPath}"`);
    const [section, key] = parts as [string, string];
    const target = (this.#config as unknown as Record<string, Record<string, unknown>>)[section];
    if (!target || !(key in target)) throw new Error(`Unknown setting "${dotPath}"`);
    const prev = target[key];
    let value: unknown = raw;
    if (typeof prev === "boolean") {
      if (!/^(true|false|1|0|yes|no|on|off)$/i.test(raw.trim())) throw new Error(`${dotPath} expects a boolean`);
      value = /^(true|1|yes|on)$/i.test(raw.trim());
    } else if (typeof prev === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${dotPath} expects a number`);
      value = n;
    } else if (prev === null) {
      value = raw === "" || raw === "null" ? null : Number.isFinite(Number(raw)) ? Number(raw) : raw;
    }
    target[key] = value;
    this.#config = coerceConfig(this.#config);
    this.save();
  }

  /** Masked key for display: `nok_…f3a2`. */
  maskKey(): string {
    const key = this.#config.router.apiKey;
    if (!key) return "";
    if (key.length <= 8) return "•".repeat(key.length);
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
  }

  patch(patch: DeepPartial<Config>): void {
    this.#config = coerceConfig(mergeConfig(this.#config, patch));
    this.save();
  }
}
