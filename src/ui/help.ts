/** Help sheet content — kept next to the UI so shortcuts stay documented. */
import { COMMANDS } from "../commands/slash.ts";

export interface ShortcutGroup {
  title: string;
  items: Array<[keys: string, description: string]>;
}

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: "Compose",
    items: [
      ["enter", "send the message"],
      ["alt+enter / ctrl+j", "insert a newline"],
      ["tab", "complete a slash command, else expand reasoning"],
      ["↑ / ↓", "prompt history (single line) or move between lines"],
      ["ctrl+a / ctrl+e", "start / end of line"],
      ["ctrl+w / alt+backspace", "delete the previous word"],
      ["ctrl+u", "clear the current line"],
      ["ctrl+k · ctrl+y", "delete to end of line · copy last code block"],
      ["esc", "close overlay · stop generation · clear input"],
    ],
  },
  {
    title: "Navigate",
    items: [
      ["ctrl+k · ctrl+p", "command palette"],
      ["ctrl+s", "sessions"],
      ["ctrl+m", "memory"],
      ["ctrl+o", "model · lane picker"],
      ["ctrl+t", "themes"],
      ["ctrl+f", "search this session"],
      ["ctrl+r", "prompt history"],
      ["pgup / pgdn · alt+↑↓", "scroll the transcript"],
      ["ctrl+home / ctrl+end", "jump to top / bottom"],
      ["ctrl+← / ctrl+→", "switch branch siblings"],
      ["?", "this sheet"],
    ],
  },
  {
    title: "Conversation",
    items: [
      ["ctrl+g", "regenerate the last answer as a new branch"],
      ["ctrl+n", "new session"],
      ["ctrl+l", "redraw the screen"],
      ["ctrl+c", "stop generation · clear input · twice to quit"],
      ["ctrl+d", "quit when the composer is empty"],
    ],
  },
];

export function markdownForHelp(): string {
  const lines: string[] = [];
  lines.push(">> kono — a stateful, colour-coded chat for nokey-router");
  lines.push("");
  for (const group of SHORTCUTS) {
    lines.push(`## ${group.title}`);
    for (const [keys, description] of group.items) {
      lines.push(`- ${keys.padEnd(24)} ${description}`);
    }
    lines.push("");
  }
  lines.push("## Commands");
  const byCategory = new Map<string, typeof COMMANDS>();
  for (const command of COMMANDS) {
    const list = byCategory.get(command.category) ?? [];
    list.push(command);
    byCategory.set(command.category, list);
  }
  for (const [category, commands] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`>> ${category}`);
    for (const command of commands) {
      const usage = command.usage ?? `/${command.name}`;
      lines.push(`- ${usage.padEnd(34)} ${command.summary}`);
    }
  }
  lines.push("");
  lines.push("## Stock");
  lines.push("- Every turn is appended to an fsynced event log; kill -9 cannot lose a finished turn.");
  lines.push("- Messages form a tree: /edit and /retry create siblings, ctrl+←/→ walks them.");
  lines.push("- Memory items are scored by lexical overlap × recency × pins and injected on budget.");
  lines.push("- Compaction summaries live in the tree, so branches inherit them automatically.");
  return lines.join("\n");
}
