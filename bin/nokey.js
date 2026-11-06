#!/usr/bin/env node
/**
 * nokey launcher.
 *
 * The CLI is written in TypeScript and is executed directly through Node's
 * type-stripping support, so there is no build step and no runtime dependency.
 * Node >= 22.6 understands `--experimental-strip-types`; Node >= 23.6 strips
 * types natively. On older runtimes we fall back to a compiled `dist/` build.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

const [major, minor] = process.versions.node.split(".").map((n) => Number.parseInt(n, 10));
const flags = [];
if (major < 23 || (major === 23 && minor < 6)) flags.push("--experimental-strip-types");
// Keep the console clean: the strip-types notice is noise for an end user.
flags.push("--no-warnings", "--disable-warning=ExperimentalWarning");

const src = join(root, "src", "cli.ts");
const dist = join(root, "dist", "cli.js");

let entry;
let argv;
if (existsSync(src) && (major > 22 || (major === 22 && minor >= 6) || major >= 23)) {
  entry = src;
  argv = [...flags, src];
} else if (existsSync(dist)) {
  entry = dist;
  argv = [dist];
} else {
  process.stderr.write(
    "nokey: this runtime cannot execute TypeScript directly.\n" +
      `       Node ${process.versions.node} found; Node >= 22.6 is required (or run "npm run build").\n`,
  );
  process.exit(1);
}

const child = spawn(process.execPath, [...argv, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, NOKEY_ENTRY: entry },
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
