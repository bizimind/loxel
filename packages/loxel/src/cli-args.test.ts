import { describe, expect, test } from "bun:test";

import { parseOpenArgs, parseTerminalArgs } from "./cli-args";

const BASE = "/home/me/repo";

/** The terminal request of `loxel terminal <args>`, without the placement. */
const terminal = (args: string[], baseDir: string) => parseTerminalArgs(args, baseDir).terminal;

describe("parseTerminalArgs", () => {
  test("no arguments opens a shell in the current directory", () => {
    expect(terminal([], BASE)).toEqual({ cwd: BASE });
  });

  test("a single command argument is used verbatim as a shell command line", () => {
    expect(terminal(["cd src && make"], BASE)).toEqual({ cwd: BASE, command: "cd src && make" });
  });

  test("several command arguments are quoted only where needed, keeping the command word bare", () => {
    expect(terminal(["--", "claude", "Fix the tests", "--model", "it's"], BASE)).toEqual({
      cwd: BASE,
      command: `claude 'Fix the tests' --model 'it'\\''s'`,
    });
    expect(terminal(["echo", "~/x", "$HOME", "*.ts", "a;b", ""], BASE)).toEqual({
      cwd: BASE,
      command: `echo '~/x' '$HOME' '*.ts' 'a;b' ''`,
    });
  });

  test("flags stop at the first non-flag so the command keeps its own flags", () => {
    expect(terminal(["--title", "agent", "claude", "--resume"], BASE)).toEqual({
      cwd: BASE,
      command: "claude --resume",
      title: "agent",
    });
  });

  test("resolves a relative cwd and accepts --flag=value", () => {
    expect(terminal(["--cwd=.worktrees/feat", "--title=t"], BASE)).toEqual({
      cwd: "/home/me/repo/.worktrees/feat",
      title: "t",
    });
    expect(terminal(["--cwd", "/tmp/x"], BASE)).toEqual({ cwd: "/tmp/x" });
  });

  test("a bare -- means no command, and a command after -- may start with a dash", () => {
    expect(terminal(["--"], BASE)).toEqual({ cwd: BASE });
    expect(terminal(["--", "-v"], BASE)).toEqual({ cwd: BASE, command: "-v" });
    expect(terminal(["--", "--cwd", "x"], BASE)).toEqual({ cwd: BASE, command: "--cwd x" });
  });

  test("rejects unknown options and missing values", () => {
    expect(() => parseTerminalArgs(["--size", "10"], BASE)).toThrow("unknown option --size");
    expect(() => parseTerminalArgs(["--cwd"], BASE)).toThrow("--cwd needs a value");
  });

  test("reads layout flags before the command", () => {
    expect(
      parseTerminalArgs(["--split", "down", "--title=dev", "--", "pnpm", "dev"], BASE),
    ).toEqual({
      terminal: { cwd: BASE, command: "pnpm dev", title: "dev" },
      placement: { split: "down" },
    });
    expect(parseTerminalArgs(["--group", "server", "--replace"], BASE)).toEqual({
      terminal: { cwd: BASE },
      placement: { group: { name: "server", path: "/home/me/repo/server" }, replace: true },
    });
  });

  test("leaves layout flags after the command to the command", () => {
    expect(parseTerminalArgs(["git", "log", "--split", "x"], BASE)).toEqual({
      terminal: { cwd: BASE, command: "git log --split x" },
    });
  });
});

describe("parseOpenArgs", () => {
  test("a target alone has no placement", () => {
    expect(parseOpenArgs(["src/app.ts"], BASE)).toEqual({ target: "src/app.ts" });
  });

  test("layout flags go before or after the target", () => {
    expect(parseOpenArgs(["--split", "right", "src/app.ts"], BASE)).toEqual({
      target: "src/app.ts",
      placement: { split: "right" },
    });
    expect(parseOpenArgs(["https://example.com", "--split=up"], BASE)).toEqual({
      target: "https://example.com",
      placement: { split: "up" },
    });
  });

  test("--group keeps the tab name and resolves it as a path against the base directory", () => {
    expect(parseOpenArgs(["a.ts", "--group", "src/b.ts", "--split", "left"], BASE)).toEqual({
      target: "a.ts",
      placement: { group: { name: "src/b.ts", path: "/home/me/repo/src/b.ts" }, split: "left" },
    });
    expect(parseOpenArgs(["--group=Terminal 2", "a.ts"], BASE).placement).toEqual({
      group: { name: "Terminal 2", path: "/home/me/repo/Terminal 2" },
    });
  });

  test("a bare - is a target", () => {
    expect(parseOpenArgs(["-"], BASE)).toEqual({ target: "-" });
  });

  test("a target starting with a dash goes after --", () => {
    expect(parseOpenArgs(["--replace", "--", "-notes.md"], BASE)).toEqual({
      target: "-notes.md",
      placement: { replace: true },
    });
  });

  test("rejects bad layout flags", () => {
    expect(() => parseOpenArgs(["--split", "middle", "a.ts"], BASE)).toThrow(
      "--split must be one of right, left, up, down",
    );
    expect(() => parseOpenArgs(["--split", "up", "--replace", "a.ts"], BASE)).toThrow(
      "--split and --replace cannot be combined",
    );
    expect(() => parseOpenArgs(["--replace=yes", "a.ts"], BASE)).toThrow(
      "--replace takes no value",
    );
    expect(() => parseOpenArgs(["--group=", "a.ts"], BASE)).toThrow("--group needs a tab title");
    expect(() => parseOpenArgs(["--help"], BASE)).toThrow("unknown option --help\nusage: loxel");
  });

  test("focus is unset unless a flag names it", () => {
    expect(parseOpenArgs(["a.ts"], BASE).focus).toBeUndefined();
    expect(parseOpenArgs(["a.ts", "--focus"], BASE)).toEqual({ target: "a.ts", focus: true });
    expect(parseOpenArgs(["--no-focus", "--split=up", "a.ts"], BASE)).toEqual({
      target: "a.ts",
      placement: { split: "up" },
      focus: false,
    });
    expect(parseTerminalArgs(["--no-focus", "--", "make"], BASE)).toEqual({
      terminal: { cwd: BASE, command: "make" },
      focus: false,
    });
  });

  test("rejects conflicting or valued focus flags", () => {
    expect(() => parseOpenArgs(["--focus", "--no-focus", "a.ts"], BASE)).toThrow(
      "--focus and --no-focus cannot be combined",
    );
    expect(() => parseTerminalArgs(["--no-focus", "--focus"], BASE)).toThrow(
      "--focus and --no-focus cannot be combined",
    );
    expect(() => parseOpenArgs(["--focus=yes", "a.ts"], BASE)).toThrow("--focus takes no value");
  });

  test("needs exactly one target", () => {
    expect(() => parseOpenArgs(["--replace"], BASE)).toThrow("missing file, folder or URL");
    expect(() => parseOpenArgs(["a.ts", "b.ts"], BASE)).toThrow(
      "expected one file, folder or URL, got 2",
    );
  });
});
