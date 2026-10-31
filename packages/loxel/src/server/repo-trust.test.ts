import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerWebSocket } from "bun";

import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";

const stateDir = mkdtempSync(join(tmpdir(), "repo-trust-state-"));
process.env.LOXEL_STATE_DIR = stateDir;

const {
  getRepoTrustStatus,
  isRepoTrusted,
  onRepoTrustChange,
  onRepoTrustStatusChange,
  repoTrustId,
  reportRepoRestriction,
  setRepoTrusted,
} = await import("./repo-trust");
const { WorktreeLspManager } = await import("./stdio-lsp-manager");
type Context = import("./stdio-lsp-manager").WtLspContext;

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "repo-trust-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

/** A main checkout with its `.git` directory, as `git init` leaves it. */
function makeRepo(name: string): string {
  const repo = join(root, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

/** A linked worktree of the repository whose common directory is `commonDir`, as git records it. */
function makeLinkedWorktree(commonDir: string, name: string): string {
  const worktree = join(root, name);
  const adminDir = join(commonDir, "worktrees", name);
  mkdirSync(worktree, { recursive: true });
  mkdirSync(adminDir, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${adminDir}\n`);
  writeFileSync(join(adminDir, "gitdir"), `${join(worktree, ".git")}\n`);
  return worktree;
}

describe("repository identity", () => {
  test("every worktree of a repository shares its trust", () => {
    const repo = makeRepo("repo");
    const worktree = makeLinkedWorktree(join(repo, ".git"), "wt");
    expect(repoTrustId(worktree)).toBe(repoTrustId(repo));

    setRepoTrusted(worktree, true);
    expect(isRepoTrusted(repo)).toBe(true);
    expect(isRepoTrusted(makeLinkedWorktree(join(repo, ".git"), "later"))).toBe(true);
  });

  test("worktrees git itself creates share the repository's identity", async () => {
    const repo = join(root, "real");
    await Bun.$`git init -q ${repo}`;
    await Bun.$`git -C ${repo} -c user.name=t -c user.email=t@t commit -q --allow-empty -m init`;
    const absolute = join(root, "real-absolute");
    const relative = join(root, "real-relative");
    await Bun.$`git -C ${repo} worktree add -q ${absolute}`;
    await Bun.$`git -C ${repo} -c worktree.useRelativePaths=true worktree add -q ${relative}`;
    expect(repoTrustId(absolute)).toBe(repoTrustId(repo));
    expect(repoTrustId(relative)).toBe(repoTrustId(repo));

    const bare = join(root, "real-bare");
    await Bun.$`git clone -q --bare ${repo} ${bare}`;
    const bareWorktrees = [join(root, "real-bare-a"), join(root, "real-bare-b")];
    for (const [i, worktree] of bareWorktrees.entries()) {
      await Bun.$`git -C ${bare} worktree add -q -b ${`b${i}`} ${worktree}`;
    }
    expect(repoTrustId(bareWorktrees[0]!)).toBe(repoTrustId(bareWorktrees[1]!));
  });

  test("a folder outside any repository stands for itself", () => {
    const folder = join(root, "folder");
    mkdirSync(join(folder, "sub"), { recursive: true });
    setRepoTrusted(folder, true);
    expect(isRepoTrusted(folder)).toBe(true);
    expect(isRepoTrusted(join(folder, "sub"))).toBe(false);
  });

  test("a path reached through a symlink is the same repository", () => {
    const repo = makeRepo("repo");
    const link = join(root, "link");
    symlinkSync(repo, link);
    expect(repoTrustId(link)).toBe(repoTrustId(repo));
  });
});

describe("a repository cannot claim trust", () => {
  test("untrusted is the default", () => {
    const repo = makeRepo("repo");
    expect(isRepoTrusted(repo)).toBe(false);
    expect(getRepoTrustStatus(repo)).toEqual({
      repository: repo,
      trusted: false,
      restrictions: [],
    });
  });

  test("a .git file naming a trusted repository does not borrow its trust", () => {
    const trusted = makeRepo("trusted");
    const worktree = makeLinkedWorktree(join(trusted, ".git"), "real");
    setRepoTrusted(trusted, true);

    const direct = join(root, "direct");
    mkdirSync(direct);
    writeFileSync(join(direct, ".git"), `gitdir: ${join(trusted, ".git")}\n`);
    expect(isRepoTrusted(direct)).toBe(false);

    const throughRealWorktree = join(root, "forged");
    mkdirSync(throughRealWorktree);
    writeFileSync(
      join(throughRealWorktree, ".git"),
      `gitdir: ${join(trusted, ".git", "worktrees", "real")}\n`,
    );
    expect(isRepoTrusted(throughRealWorktree)).toBe(false);
    expect(isRepoTrusted(worktree)).toBe(true);
  });

  test("a checkout naming a trusted folder as its repository does not take its answer", () => {
    const trustedFolder = join(root, "trusted");
    const inside = join(trustedFolder, "evil");
    mkdirSync(inside, { recursive: true });
    setRepoTrusted(trustedFolder, true);
    const adminDir = join(trustedFolder, "worktrees", "x");
    mkdirSync(adminDir, { recursive: true });
    writeFileSync(join(inside, ".git"), "gitdir: ../worktrees/x\n");
    writeFileSync(join(adminDir, "gitdir"), "../../evil/.git\n");
    expect(isRepoTrusted(inside)).toBe(false);
  });

  test("a symlinked .git does not borrow trust", () => {
    const trusted = makeRepo("trusted");
    setRepoTrusted(trusted, true);
    const forged = join(root, "forged");
    mkdirSync(forged);
    symlinkSync(join(trusted, ".git"), join(forged, ".git"));
    expect(isRepoTrusted(forged)).toBe(false);
  });

  test("a .git directory's commondir file is not followed", () => {
    const trusted = makeRepo("trusted");
    setRepoTrusted(trusted, true);
    const forged = makeRepo("forged");
    writeFileSync(join(forged, ".git", "commondir"), `${join(trusted, ".git")}\n`);
    expect(isRepoTrusted(forged)).toBe(false);
  });

  test("another repository cloned at a trusted path starts untrusted", () => {
    const repo = makeRepo("repo");
    setRepoTrusted(repo, true);
    rmSync(repo, { recursive: true });
    makeRepo("repo");
    expect(isRepoTrusted(repo)).toBe(false);
  });

  test("ordinary git activity keeps trust", () => {
    const repo = makeRepo("repo");
    setRepoTrusted(repo, true);
    writeFileSync(join(repo, ".git", "index"), "changed");
    rmSync(join(repo, ".git", "index"));
    expect(isRepoTrusted(repo)).toBe(true);
  });

  test("a row the store cannot parse counts as untrusted", async () => {
    const { putStore } = await import("./store-db");
    const repo = makeRepo("repo");
    putStore(`repo-trust:${repoTrustId(repo)}`, "{not json");
    expect(isRepoTrusted(repo)).toBe(false);
  });
});

describe("trust changes and restrictions", () => {
  test("revoking takes trust away and tells subscribers each time", () => {
    const repo = makeRepo("repo");
    const seen: boolean[] = [];
    const unsubscribe = onRepoTrustChange(() => seen.push(isRepoTrusted(repo)));
    setRepoTrusted(repo, true);
    setRepoTrusted(repo, false);
    unsubscribe();
    setRepoTrusted(repo, true);
    expect(seen).toEqual([true, false]);
  });

  test("a restriction shows until the repository is trusted, and is told once", () => {
    const repo = makeRepo("repo");
    const worktree = makeLinkedWorktree(join(repo, ".git"), "wt");
    let told = 0;
    const unsubscribe = onRepoTrustStatusChange(() => (told += 1));

    reportRepoRestriction(worktree, "Build scripts don't run.");
    reportRepoRestriction(repo, "Build scripts don't run.");
    expect(told).toBe(1);
    expect(getRepoTrustStatus(repo).restrictions).toEqual(["Build scripts don't run."]);

    setRepoTrusted(repo, true);
    expect(getRepoTrustStatus(repo).restrictions).toEqual([]);
    expect(told).toBe(2);
    unsubscribe();

    reportRepoRestriction(repo, "Build scripts don't run.");
    setRepoTrusted(repo, false);
    expect(getRepoTrustStatus(repo).restrictions).toEqual([]);
  });
});

/** A stand-in that states both behaviors the way a real manager does, with one flag per hook. */
class ExampleLspManager extends WorktreeLspManager {
  protected override readonly repoTrustRestriction = "Build scripts don't run.";
  readonly argsSeen: boolean[] = [];

  constructor() {
    super("python-lsp");
  }

  protected resolveBinary(): string | Promise<string> {
    return process.execPath;
  }

  protected override spawnArgs({ repoTrusted }: Context): readonly string[] {
    this.argsSeen.push(repoTrusted);
    return ["-e", "await new Promise(() => {});"];
  }
}

function fakeWebSocket(): { ws: ServerWebSocket<unknown>; closed: Promise<number> } {
  const { promise, resolve } = Promise.withResolvers<number>();
  const ws = {
    send: () => 0,
    close: (code: number) => resolve(code),
  } as unknown as ServerWebSocket<unknown>;
  return { ws, closed: promise };
}

describe("WorktreeLspManager", () => {
  test("a manager stating a restriction starts restricted, reports it and restarts on trust", async () => {
    const repo = makeRepo("repo");
    const worktree = makeLinkedWorktree(join(repo, ".git"), "wt");
    const manager = new ExampleLspManager();
    try {
      const first = fakeWebSocket();
      manager.createSession(first.ws, worktree);
      expect(manager.argsSeen).toEqual([false]);
      expect(getRepoTrustStatus(worktree).restrictions).toEqual(["Build scripts don't run."]);

      // Trusting through another worktree of the repository restarts this one's server.
      setRepoTrusted(repo, true);
      expect(await first.closed).toBe(LSP_RESTART_CLOSE_CODE);

      const second = fakeWebSocket();
      manager.createSession(second.ws, worktree);
      expect(manager.argsSeen).toEqual([false, true]);

      setRepoTrusted(repo, false);
      expect(await second.closed).toBe(LSP_RESTART_CLOSE_CODE);
    } finally {
      await manager.destroy();
    }
  });

  test("a server still starting when trust changes never spawns on the old answer", async () => {
    const repo = makeRepo("repo");
    setRepoTrusted(repo, true);
    const binary = Promise.withResolvers<string>();
    class SlowBinaryManager extends ExampleLspManager {
      protected override resolveBinary(): Promise<string> {
        return binary.promise;
      }
    }
    const manager = new SlowBinaryManager();
    try {
      const socket = fakeWebSocket();
      manager.createSession(socket.ws, repo);
      setRepoTrusted(repo, false);
      binary.resolve(process.execPath);
      expect(await socket.closed).toBe(LSP_RESTART_CLOSE_CODE);
      expect(manager.argsSeen).toEqual([]);
    } finally {
      await manager.destroy();
    }
  });

  test("a manager with no restriction ignores trust changes", async () => {
    class PlainLspManager extends WorktreeLspManager {
      constructor() {
        super("python-lsp");
      }
      protected resolveBinary(): string {
        return process.execPath;
      }
      protected override spawnArgs(): readonly string[] {
        return ["-e", "await new Promise(() => {});"];
      }
    }
    const repo = makeRepo("repo");
    const manager = new PlainLspManager();
    try {
      let closes = 0;
      const ws = {
        send: () => 0,
        close: () => (closes += 1),
      } as unknown as ServerWebSocket<unknown>;
      manager.createSession(ws, repo);
      setRepoTrusted(repo, true);
      await Promise.resolve();
      expect(closes).toBe(0);
      expect(getRepoTrustStatus(repo).restrictions).toEqual([]);
    } finally {
      await manager.destroy();
    }
  });
});
