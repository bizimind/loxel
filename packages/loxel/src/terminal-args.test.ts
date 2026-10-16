import { describe, expect, test } from "bun:test";

import { parseTerminalArgs } from "./terminal-args";

const BASE = "/home/me/repo";

describe("parseTerminalArgs", () => {
  test("no arguments opens a shell in the current directory", () => {
    expect(parseTerminalArgs([], BASE)).toEqual({ cwd: BASE });
  });

  test("a single command argument is used verbatim as a shell command line", () => {
    expect(parseTerminalArgs(["cd src && make"], BASE)).toEqual({
      cwd: BASE,
      command: "cd src && make",
    });
  });

  test("several command arguments are quoted only where needed, keeping the command word bare", () => {
    expect(parseTerminalArgs(["--", "claude", "Fix the tests", "--model", "it's"], BASE)).toEqual({
      cwd: BASE,
      command: `claude 'Fix the tests' --model 'it'\\''s'`,
    });
    expect(parseTerminalArgs(["echo", "~/x", "$HOME", "*.ts", "a;b", ""], BASE)).toEqual({
      cwd: BASE,
      command: `echo '~/x' '$HOME' '*.ts' 'a;b' ''`,
    });
  });

  test("flags stop at the first non-flag so the command keeps its own flags", () => {
    expect(parseTerminalArgs(["--title", "agent", "claude", "--resume"], BASE)).toEqual({
      cwd: BASE,
      command: "claude --resume",
      title: "agent",
    });
  });

  test("resolves a relative cwd and accepts --flag=value", () => {
    expect(parseTerminalArgs(["--cwd=.worktrees/feat", "--title=t"], BASE)).toEqual({
      cwd: "/home/me/repo/.worktrees/feat",
      title: "t",
    });
    expect(parseTerminalArgs(["--cwd", "/tmp/x"], BASE)).toEqual({ cwd: "/tmp/x" });
  });

  test("a bare -- means no command, and a command after -- may start with a dash", () => {
    expect(parseTerminalArgs(["--"], BASE)).toEqual({ cwd: BASE });
    expect(parseTerminalArgs(["--", "-v"], BASE)).toEqual({ cwd: BASE, command: "-v" });
    expect(parseTerminalArgs(["--", "--cwd", "x"], BASE)).toEqual({
      cwd: BASE,
      command: "--cwd x",
    });
  });

  test("rejects unknown options and missing values", () => {
    expect(() => parseTerminalArgs(["--split", "right"], BASE)).toThrow("unknown option --split");
    expect(() => parseTerminalArgs(["--cwd"], BASE)).toThrow("--cwd needs a value");
  });
});
