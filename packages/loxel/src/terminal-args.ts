/**
 * Arguments of `loxel terminal`: flags for the shell's directory and the tab title, then the
 * command to type into the shell. Shared by the CLI and its tests; the request itself is
 * `OpenTerminalRequest` in open-request.ts.
 */
import { resolve } from "node:path";

import { shellQuote } from "@bizimind/wt/lib";

import type { OpenTerminalRequest } from "./open-request";

export const TERMINAL_USAGE =
  "usage: loxel terminal [--cwd <dir>] [--title <name>] [--] [command...]";

/**
 * Parse the arguments after `terminal`. Flags are read until `--` or the first argument that is
 * not a flag; everything after is the command. A single command argument is a shell command line
 * used verbatim (like tmux and ssh), so `loxel terminal 'cd src && make'` works. Several arguments
 * are quoted individually and joined, so `loxel terminal -- claude "Fix the tests"` passes the
 * prompt to claude as one argument. Relative `--cwd` values resolve against `baseDir`.
 */
export function parseTerminalArgs(args: string[], baseDir: string): OpenTerminalRequest {
  let cwd = baseDir;
  let title: string | undefined;
  let i = 0;

  const flagValue = (name: string): string => {
    const value = args[i + 1];
    if (value === undefined) throw new Error(`${name} needs a value\n${TERMINAL_USAGE}`);
    i += 2;
    return value;
  };

  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--") {
      i++;
      break;
    }
    if (!arg.startsWith("-")) break;
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inlineValue = equals === -1 ? null : arg.slice(equals + 1);
    const value = (): string => (inlineValue === null ? flagValue(name) : (i++, inlineValue));
    switch (name) {
      case "--cwd":
        cwd = resolve(baseDir, value());
        break;
      case "--title":
        title = value();
        break;
      default:
        throw new Error(`unknown option ${name}\n${TERMINAL_USAGE}`);
    }
  }

  const commandArgs = args.slice(i);
  const command =
    commandArgs.length === 0
      ? undefined
      : commandArgs.length === 1
        ? commandArgs[0]
        : commandArgs.map(shellQuote).join(" ");

  return { cwd, ...(command ? { command } : {}), ...(title ? { title } : {}) };
}
