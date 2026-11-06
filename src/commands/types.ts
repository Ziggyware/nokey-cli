/** The surface slash commands are allowed to touch. */
import type { NoKeyRouter } from "../router/client.ts";
import type { ConfigStore } from "../store/config.ts";
import type { MemoryBank, MemoryStack } from "../store/memory.ts";
import type { Session, SessionStore, SessionSummary } from "../store/session.ts";
import type { TurnEngine } from "../core/engine.ts";
import type { OverlayState } from "../ui/overlays.ts";
import type { Theme, Token } from "../ui/theme.ts";

export type NoticeTone = "info" | "warn" | "error" | "ok";

export interface CommandHost {
  readonly configStore: ConfigStore;
  readonly router: NoKeyRouter;
  readonly store: SessionStore;
  readonly memory: MemoryStack;
  readonly autoBank: MemoryBank;
  readonly sessionBank: MemoryBank;
  readonly session: Session;
  readonly engine: TurnEngine;
  readonly theme: Theme;
  /** Append markdown to the on-screen log (not part of the conversation). */
  print(markdown: string, tone?: Token): void;
  notice(text: string, tone?: NoticeTone, ms?: number): void;
  openOverlay(state: OverlayState): void;
  closeOverlay(): void;
  newSession(opts?: { title?: string }): void;
  switchSession(id: string): void;
  sessions(): SessionSummary[];
  setTheme(name: string): boolean;
  send(text: string): void;
  /** Regenerate the last answer as a sibling branch. */
  retry(): void;

  /** Resolver installed by the app so Esc can cancel a confirm overlay. */
  pendingConfirm?: (() => void) | null;
  refresh(): void;
  exit(code?: number): void;
  showHelp(): void;
  listModels(): Promise<string[]>;
  copyToClipboard(text: string): Promise<string>;
  exportSession(format: "md" | "json", path?: string): Promise<string>;
  importSession(path: string): Promise<void>;
  confirm(title: string, prompt: string, onAccept: () => void): void;
  saveConfig(): void;
  settingsSummary(): string;
  reloadConfig(): void;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  summary: string;
  usage?: string;
  category: "session" | "model" | "memory" | "context" | "workspace" | "app" | "tools";
  keys?: string;
  run(host: CommandHost, args: string[], raw: string): Promise<void> | void;
}
