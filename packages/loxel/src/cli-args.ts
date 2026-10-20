/**
 * Arguments of the `loxel` CLI: `loxel <target>` and `loxel terminal`, both with the layout flags
 * that place the new panel. Shared by the CLI and its tests; the requests themselves are in
 * open-request.ts.
 */
import { resolve } from "node:path";

import { shellQuote } from "@bizimind/wt/lib";

import type { PanelPlacement } from "./api/panel-placement-model";
import { SPLIT_DIRECTIONS, isSplitDirection } from "./api/panel-placement-model";
import type { OpenTerminalRequest } from "./open-request";

/**
 * Arguments made only of these characters need no quoting: no whitespace, no quotes, and none of
 * the characters that start tilde, parameter, glob or command substitution. Leaving such words bare
 * keeps the command word unquoted, which POSIX shells require for alias expansion.
 */
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

const quoteArg = (arg: string): string => (SAFE_WORD.test(arg) ? arg : shellQuote(arg));

const LAYOUT_FLAGS = "[--split left|right|up|down | --replace] [--group <tab>]";

const TERMINAL_SYNOPSIS = `loxel terminal [--cwd <dir>] [--title <name>] ${LAYOUT_FLAGS} [--] [command...]`;

export const OPEN_USAGE = `usage: loxel ${LAYOUT_FLAGS} <file | folder | url>\n       ${TERMINAL_SYNOPSIS}`;

export const TERMINAL_USAGE = `usage: ${TERMINAL_SYNOPSIS}`;

const usageError = (message: string, usage: string): Error => new Error(`${message}\n${usage}`);

interface Flag {
  name: string;
  /** The flag's value, inline (`--flag=value`) or the next argument. */
  value: () => string;
  /** Reject an inline value on a flag that takes none. */
  noValue: () => void;
}

/**
 * Read `args`, calling `onFlag` for each flag; it returns false for a flag it does not know. `--`
 * ends the flags, and with `untilPositional` so does the first argument that is not a flag.
 * Returns the positional arguments, in order.
 */
function scanArgs(
  args: string[],
  usage: string,
  untilPositional: boolean,
  onFlag: (flag: Flag) => boolean,
): string[] {
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--") return [...positional, ...args.slice(i + 1)];
    // A bare `-` is a name, as in getopt.
    if (arg === "-" || !arg.startsWith("-")) {
      if (untilPositional) return [...positional, ...args.slice(i)];
      positional.push(arg);
      i++;
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inlineValue = equals === -1 ? null : arg.slice(equals + 1);
    i++;
    const flag: Flag = {
      name,
      value: () => {
        if (inlineValue !== null) return inlineValue;
        const next = args[i];
        if (next === undefined) throw usageError(`${name} needs a value`, usage);
        i++;
        return next;
      },
      noValue: () => {
        if (inlineValue !== null) throw usageError(`${name} takes no value`, usage);
      },
    };
    if (!onFlag(flag)) throw usageError(`unknown option ${name}`, usage);
  }
  return positional;
}

/**
 * Collects the layout flags. `--group` keeps the name as typed (a tab title) and also resolves it
 * against `baseDir` (the path of a file open in a tab); the server drops the path if nothing
 * exists there.
 */
function placementFlags(baseDir: string, usage: string) {
  const placement: PanelPlacement = {};
  return {
    read(flag: Flag): boolean {
      switch (flag.name) {
        case "--split": {
          const direction = flag.value();
          if (!isSplitDirection(direction)) {
            throw usageError(`--split must be one of ${SPLIT_DIRECTIONS.join(", ")}`, usage);
          }
          placement.split = direction;
          return true;
        }
        case "--replace":
          flag.noValue();
          placement.replace = true;
          return true;
        case "--group": {
          const name = flag.value();
          if (name === "") throw usageError("--group needs a tab title or file path", usage);
          placement.group = { name, path: resolve(baseDir, name) };
          return true;
        }
        default:
          return false;
      }
    },
    /** The placement, or undefined when no layout flag was given. */
    result(): PanelPlacement | undefined {
      if (placement.split && placement.replace) {
        throw usageError("--split and --replace cannot be combined", usage);
      }
      return Object.keys(placement).length > 0 ? placement : undefined;
    },
  };
}

/** What `loxel <target>` opens: a file, folder or URL as typed, and where its panel goes. */
export interface OpenArgs {
  target: string;
  placement?: PanelPlacement;
}

/**
 * Parse the arguments of `loxel <target>`: exactly one file, folder or URL, with layout flags
 * before or after it. A target that starts with a dash goes after `--`.
 */
export function parseOpenArgs(args: string[], baseDir: string): OpenArgs {
  const layout = placementFlags(baseDir, OPEN_USAGE);
  const positional = scanArgs(args, OPEN_USAGE, false, (flag) => layout.read(flag));
  if (positional.length !== 1) {
    throw usageError(
      positional.length === 0
        ? "missing file, folder or URL"
        : `expected one file, folder or URL, got ${positional.length}`,
      OPEN_USAGE,
    );
  }
  const placement = layout.result();
  return { target: positional[0]!, ...(placement ? { placement } : {}) };
}

/** What `loxel terminal` opens, and where its panel goes. */
export interface TerminalArgs {
  terminal: OpenTerminalRequest;
  placement?: PanelPlacement;
}

/**
 * Parse the arguments after `terminal`. Flags are read until `--` or the first argument that is
 * not a flag; everything after is the command. A single command argument is a shell command line
 * used verbatim (like tmux and ssh), so `loxel terminal 'cd src && make'` works. Several arguments
 * are quoted where needed and joined, so `loxel terminal -- claude "Fix the tests"` passes the
 * prompt to claude as one argument while the command word stays bare for alias expansion. Relative
 * `--cwd` and `--group` values resolve against `baseDir`.
 */
export function parseTerminalArgs(args: string[], baseDir: string): TerminalArgs {
  let cwd = baseDir;
  let title: string | undefined;
  const layout = placementFlags(baseDir, TERMINAL_USAGE);

  const commandArgs = scanArgs(args, TERMINAL_USAGE, true, (flag) => {
    switch (flag.name) {
      case "--cwd":
        cwd = resolve(baseDir, flag.value());
        return true;
      case "--title":
        title = flag.value();
        return true;
      default:
        return layout.read(flag);
    }
  });

  const command =
    commandArgs.length === 0
      ? undefined
      : commandArgs.length === 1
        ? commandArgs[0]
        : commandArgs.map(quoteArg).join(" ");

  const placement = layout.result();
  return {
    terminal: { cwd, ...(command ? { command } : {}), ...(title ? { title } : {}) },
    ...(placement ? { placement } : {}),
  };
}
