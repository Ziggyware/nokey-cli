/**
 * Clipboard.
 *
 * Tries the platform helper first (pbcopy, wl-copy, xclip, clip.exe) and falls
 * back to OSC 52, which works through SSH and tmux (`set -g set-clipboard on`).
 */
import { spawn } from "node:child_process";

export type ClipboardMethod = "pbcopy" | "wl-copy" | "xclip" | "xsel" | "clip" | "osc52" | "none";

function tryCommand(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin.end(text);
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        resolve(false);
      }, 1500);
    } catch {
      resolve(false);
    }
  });
}

export function osc52(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return `\x1b]52;c;${b64}\x07`;
}

export async function copyToClipboard(
  text: string,
  opts: { write: (s: string) => void; forceOsc?: boolean } = { write: () => {} },
): Promise<ClipboardMethod> {
  if (!opts.forceOsc) {
    const platform = process.platform;
    const candidates: Array<[string, string[]]> =
      platform === "darwin"
        ? [["pbcopy", []]]
        : platform === "win32"
          ? [["clip", []]]
          : [
              ["wl-copy", []],
              ["xclip", ["-selection", "clipboard"]],
              ["xsel", ["--clipboard", "--input"]],
            ];
    for (const [cmd, args] of candidates) {
      if (await tryCommand(cmd, args, text)) return cmd as ClipboardMethod;
    }
  }
  opts.write(osc52(text));
  return "osc52";
}
