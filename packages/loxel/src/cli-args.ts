/**
 * Arguments of the `loxel` CLI: `loxel <target>...` and `loxel terminal`, both with the open flags:
 * the layout flags that place the new panel, the worktree it goes to, and whether it takes focus.
 * Shared by the CLI and its tests; the requests themselves are in open-request.ts.
 */
import { resolve } from "node:path";

import { shellQuote } from "@bizimind/wt/lib";

import type { PanelOpenOptions, PanelPlacement } from "./api/panel-placement-model";
import { SPLIT_DIRECTIONS, isSplitDirection } from "./api/panel-placement-model";
import type { OpenRequest, OpenTerminalRequest } from "./open-request";
import { isHttpUrl } from "./url-utils";

/**
 * Arguments made only of these characters need no quoting: no whitespace, no quotes, and none of
 * the characters that start tilde, parameter, glob or command substitution. Leaving such words bare
 * keeps the command word unquoted, which POSIX shells require for alias expansion.
 */
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

const quoteArg = (arg: string): string => (SAFE_WORD.test(arg) ? arg : shellQuote(arg));

const OPEN_FLAGS =
  "[--split left|right|up|down | --replace] [--group <tab>] [--worktree <path>] [--focus | --no-focus]";

const TERMINAL_SYNOPSIS = `loxel terminal [--cwd <dir>] [--title <name>] ${OPEN_FLAGS} [--] [command...]`;

export const OPEN_USAGE = `usage: loxel ${OPEN_FLAGS} <file | folder | url>...\n       ${TERMINAL_SYNOPSIS}`;

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

/** The open flags given. */
interface OpenFlags extends PanelOpenOptions {
  /** `--worktree`, resolved against the base directory: a directory in the worktree to open in. */
  worktree?: string;
}

/**
 * Collects the open flags. `--group` keeps the name as typed (a tab title) and also resolves it
 * against `baseDir` (the path of a file open in a tab); the server drops the path if nothing
 * exists there. Focus is left unset unless a flag names it: its default depends on the caller.
 */
function openFlags(baseDir: string, usage: string) {
  const placement: PanelPlacement = {};
  const focus = new Set<boolean>();
  let worktree: string | undefined;
  return {
    read(flag: Flag): boolean {
      switch (flag.name) {
        case "--focus":
        case "--no-focus":
          flag.noValue();
          focus.add(flag.name === "--focus");
          return true;
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
        case "--worktree": {
          const path = flag.value();
          if (path === "") throw usageError("--worktree needs a path", usage);
          worktree = resolve(baseDir, path);
          return true;
        }
        default:
          return false;
      }
    },
    /** The flags given: a placement if any layout flag was, and so on for the others. */
    result(): OpenFlags {
      if (placement.split && placement.replace) {
        throw usageError("--split and --replace cannot be combined", usage);
      }
      if (focus.size > 1) throw usageError("--focus and --no-focus cannot be combined", usage);
      const [focused] = focus;
      return {
        ...(Object.keys(placement).length > 0 ? { placement } : {}),
        ...(focused === undefined ? {} : { focus: focused }),
        ...(worktree ? { worktree } : {}),
      };
    },
  };
}

/** What `loxel <target>...` opens: files, folders and URLs as typed, and how. */
export interface OpenArgs extends OpenFlags {
  targets: string[];
}

/**
 * Parse the arguments of `loxel <target>...`: one or more files, folders or URLs, with open flags
 * before, between or after them. A target that starts with a dash goes after `--`. `--replace`
 * takes a single target: each would close the tab the one before it just opened.
 */
export function parseOpenArgs(args: string[], baseDir: string): OpenArgs {
  const flags = openFlags(baseDir, OPEN_USAGE);
  const positional = scanArgs(args, OPEN_USAGE, false, (flag) => flags.read(flag));
  if (positional.length === 0) throw usageError("missing file, folder or URL", OPEN_USAGE);
  const result = flags.result();
  if (result.placement?.replace && positional.length > 1) {
    throw usageError(`--replace takes one target, got ${positional.length}`, OPEN_USAGE);
  }
  return { targets: positional, ...result };
}

/** What `loxel terminal` opens, and how. */
export interface TerminalArgs extends OpenFlags {
  terminal: OpenTerminalRequest;
}

/**
 * Parse the arguments after `terminal`. Flags are read until `--` or the first argument that is
 * not a flag; everything after is the command. A single command argument is a shell command line
 * used verbatim (like tmux and ssh), so `loxel terminal 'cd src && make'` works. Several arguments
 * are quoted where needed and joined, so `loxel terminal -- claude "Fix the tests"` passes the
 * prompt to claude as one argument while the command word stays bare for alias expansion. Relative
 * `--cwd`, `--group` and `--worktree` values resolve against `baseDir`. The shell starts in `--cwd`,
 * else in the `--worktree` directory, else in `baseDir`.
 */
export function parseTerminalArgs(args: string[], baseDir: string): TerminalArgs {
  let cwd: string | undefined;
  let title: string | undefined;
  const flags = openFlags(baseDir, TERMINAL_USAGE);

  const commandArgs = scanArgs(args, TERMINAL_USAGE, true, (flag) => {
    switch (flag.name) {
      case "--cwd":
        cwd = resolve(baseDir, flag.value());
        return true;
      case "--title":
        title = flag.value();
        return true;
      default:
        return flags.read(flag);
    }
  });

  const command =
    commandArgs.length === 0
      ? undefined
      : commandArgs.length === 1
        ? commandArgs[0]
        : commandArgs.map(quoteArg).join(" ");

  const result = flags.result();
  return {
    terminal: {
      cwd: cwd ?? result.worktree ?? baseDir,
      ...(command ? { command } : {}),
      ...(title ? { title } : {}),
    },
    ...result,
  };
}

/** One request of a command, with the prefix naming its target in messages when there are several. */
export interface PlannedOpen {
  label: string;
  /** Absent for a URL with no worktree to open in, which fails by itself. */
  request?: OpenRequest;
}

/**
 * The requests of `loxel <target>...`, in order. A command with a worktree opens every target
 * there: `pinnedWorktree` (`--worktree`) must be a project's, while `commandWorktree` (the one a URL
 * needs) is the CWD's, so a file ignores it if it is not. With neither, `urlsToWindow` (a Home
 * terminal's command) sends URLs with no worktree, for the window to open in what it shows. Several
 * targets with `--split` share one split, through a `batch` on their placement.
 */
export function planOpens(
  { targets, placement }: Pick<OpenArgs, "targets" | "placement">,
  {
    baseDir,
    pinnedWorktree,
    commandWorktree,
    urlsToWindow = false,
    options,
  }: {
    baseDir: string;
    pinnedWorktree: string | null;
    commandWorktree: string | null;
    urlsToWindow?: boolean;
    options: Pick<OpenRequest, "focus" | "windowId">;
  },
): PlannedOpen[] {
  const opened = {
    ...(targets.length > 1 && placement?.split
      ? { placement: { ...placement, batch: crypto.randomUUID() } }
      : placement
        ? { placement }
        : {}),
    ...options,
  };
  const worktree = pinnedWorktree
    ? { pinWtPath: pinnedWorktree }
    : commandWorktree
      ? { commandWtPath: commandWorktree }
      : {};
  return targets.map((target) => {
    const label = targets.length > 1 ? `${target}: ` : "";
    if (!isHttpUrl(target)) {
      return { label, request: { filePath: resolve(baseDir, target), ...worktree, ...opened } };
    }
    if (commandWorktree)
      return { label, request: { url: target, wtPath: commandWorktree, ...opened } };
    return urlsToWindow ? { label, request: { url: target, ...opened } } : { label };
  });
}
