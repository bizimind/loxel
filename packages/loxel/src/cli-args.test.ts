import { describe, expect, test } from "bun:test";

import { parseOpenArgs, parseTerminalArgs, planOpens } from "./cli-args";

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
    expect(parseOpenArgs(["src/app.ts"], BASE)).toEqual({ targets: ["src/app.ts"] });
  });

  test("layout flags go before or after the target", () => {
    expect(parseOpenArgs(["--split", "right", "src/app.ts"], BASE)).toEqual({
      targets: ["src/app.ts"],
      placement: { split: "right" },
    });
    expect(parseOpenArgs(["https://example.com", "--split=up"], BASE)).toEqual({
      targets: ["https://example.com"],
      placement: { split: "up" },
    });
  });

  test("--group keeps the tab name and resolves it as a path against the base directory", () => {
    expect(parseOpenArgs(["a.ts", "--group", "src/b.ts", "--split", "left"], BASE)).toEqual({
      targets: ["a.ts"],
      placement: { group: { name: "src/b.ts", path: "/home/me/repo/src/b.ts" }, split: "left" },
    });
    expect(parseOpenArgs(["--group=Terminal 2", "a.ts"], BASE).placement).toEqual({
      group: { name: "Terminal 2", path: "/home/me/repo/Terminal 2" },
    });
  });

  test("a bare - is a target", () => {
    expect(parseOpenArgs(["-"], BASE)).toEqual({ targets: ["-"] });
  });

  test("a target starting with a dash goes after --", () => {
    expect(parseOpenArgs(["--replace", "--", "-notes.md"], BASE)).toEqual({
      targets: ["-notes.md"],
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
    expect(parseOpenArgs(["a.ts", "--focus"], BASE)).toEqual({ targets: ["a.ts"], focus: true });
    expect(parseOpenArgs(["--no-focus", "--split=up", "a.ts"], BASE)).toEqual({
      targets: ["a.ts"],
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

  test("needs a target", () => {
    expect(() => parseOpenArgs(["--replace"], BASE)).toThrow("missing file, folder or URL");
  });

  test("takes several targets in order, with flags anywhere among them", () => {
    expect(parseOpenArgs(["a.md", "b.md", "https://example.com"], BASE)).toEqual({
      targets: ["a.md", "b.md", "https://example.com"],
    });
    expect(parseOpenArgs(["a.md", "--split", "right", "b.md", "--no-focus", "c.md"], BASE)).toEqual(
      { targets: ["a.md", "b.md", "c.md"], placement: { split: "right" }, focus: false },
    );
    expect(parseOpenArgs(["a.md", "--", "-b.md", "--split"], BASE).targets).toEqual([
      "a.md",
      "-b.md",
      "--split",
    ]);
  });

  test("--replace takes one target, since each would close the tab of the one before", () => {
    expect(() => parseOpenArgs(["--replace", "a.md", "b.md"], BASE)).toThrow(
      "--replace takes one target, got 2",
    );
    expect(parseOpenArgs(["--replace", "a.md"], BASE).targets).toEqual(["a.md"]);
  });

  test("--worktree resolves against the base directory", () => {
    expect(parseOpenArgs(["a.md", "--worktree", ".worktrees/x"], BASE)).toEqual({
      targets: ["a.md"],
      worktree: "/home/me/repo/.worktrees/x",
    });
    expect(parseOpenArgs(["--worktree=/wt", "a.md"], BASE).worktree).toBe("/wt");
    expect(() => parseOpenArgs(["--worktree=", "a.md"], BASE)).toThrow("--worktree needs a path");
    expect(() => parseOpenArgs(["a.md", "--worktree"], BASE)).toThrow("--worktree needs a value");
  });

  test("a terminal starts in --cwd, else in the --worktree directory", () => {
    expect(parseTerminalArgs(["--worktree", "/wt", "--", "ls"], BASE)).toEqual({
      terminal: { cwd: "/wt", command: "ls" },
      worktree: "/wt",
    });
    expect(terminal(["--worktree", "/wt", "--cwd", "/elsewhere"], BASE).cwd).toBe("/elsewhere");
  });
});

describe("planOpens", () => {
  const plan = (
    targets: string[],
    worktrees: { pinnedWorktree?: string; commandWorktree?: string } = {},
    placement?: { split?: "right"; group?: { name: string } },
  ) =>
    planOpens(
      { targets, ...(placement ? { placement } : {}) },
      {
        baseDir: BASE,
        pinnedWorktree: worktrees.pinnedWorktree ?? null,
        commandWorktree: worktrees.pinnedWorktree ?? worktrees.commandWorktree ?? null,
        options: { focus: true },
      },
    );

  test("a single target has no label, and a file alone names no worktree", () => {
    expect(plan(["a.md"])).toEqual([
      { label: "", request: { filePath: "/home/me/repo/a.md", focus: true } },
    ]);
  });

  test("a command's URLs and files share its worktree, leniently for the files", () => {
    expect(plan(["a.md", "https://x.dev"], { commandWorktree: "/wt" })).toEqual([
      {
        label: "a.md: ",
        request: { filePath: "/home/me/repo/a.md", commandWtPath: "/wt", focus: true },
      },
      { label: "https://x.dev: ", request: { url: "https://x.dev", wtPath: "/wt", focus: true } },
    ]);
  });

  test("--worktree pins every target", () => {
    expect(
      plan(["a.md", "https://x.dev"], { pinnedWorktree: "/wt" }).map((o) => o.request),
    ).toEqual([
      { filePath: "/home/me/repo/a.md", pinWtPath: "/wt", focus: true },
      { url: "https://x.dev", wtPath: "/wt", focus: true },
    ]);
  });

  test("a Home terminal's URL goes to the window, with no worktree", () => {
    const planned = planOpens(
      { targets: ["https://x.dev"] },
      {
        baseDir: BASE,
        pinnedWorktree: null,
        commandWorktree: null,
        urlsToWindow: true,
        options: { focus: true, windowId: "w1" },
      },
    );
    expect(planned).toEqual([
      { label: "", request: { url: "https://x.dev", focus: true, windowId: "w1" } },
    ]);
  });

  test("a URL with no worktree has no request, and the files still go", () => {
    const [file, url] = plan(["a.md", "https://x.dev"]);
    expect(file!.request).toEqual({ filePath: "/home/me/repo/a.md", focus: true });
    expect(url).toEqual({ label: "https://x.dev: " });
  });

  test("several targets with --split share one batch; other placements need none", () => {
    const placements = plan(["a.md", "b.md"], {}, { split: "right" }).map(
      (open) => open.request?.placement,
    );
    expect(placements[0]?.batch).toBeString();
    expect(placements[1]).toEqual(placements[0]);

    expect(plan(["a.md"], {}, { split: "right" })[0]!.request?.placement).toEqual({
      split: "right",
    });
    expect(plan(["a.md", "b.md"], {}, { group: { name: "x" } })[0]!.request?.placement).toEqual({
      group: { name: "x" },
    });
  });
});
