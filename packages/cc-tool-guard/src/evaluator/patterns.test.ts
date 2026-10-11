import { describe, expect, test } from "bun:test";

import type { ProjectContext } from "../types.ts";
import { checkKnownPatterns } from "./patterns.ts";

const context: ProjectContext = {
  projectRoot: "/home/user/project",
  currentBranch: "feature",
  cwd: "/home/user/project",
  isGitRepo: true,
};

function classify(command: string): string | null {
  return checkKnownPatterns(command, context)?.classification ?? null;
}

describe("dangerous rm patterns", () => {
  describe("recursive delete of the current or parent directory", () => {
    test.each([
      "rm -rf .",
      "rm -rf ./",
      "rm -fr .",
      "rm -r -f .",
      "rm -R .",
      "rm --recursive .",
      "rm --recursive --force .",
      "rm -rf -- .",
      "rm -rf ..",
      "rm -rf ../",
      "rm -rf ../..",
      "rm -rf ./..",
      "rm -rf ../../../..",
      "rm -rf .//",
      "rm -rf ..//.",
      "rm -rf .///",
      "rm -rf dist .",
      "rm -rf . dist",
      'rm -rf "."',
      "rm -rf '.'",
      "rm -rf './'",
    ])("%s is uncertain", (command) => {
      expect(classify(command)).toBe("uncertain");
    });
  });

  describe("recursive delete with a wildcard glob in the current or parent directory", () => {
    test.each([
      "rm -rf *",
      "rm -rf *.js",
      "rm -rf ./*",
      "rm -rf -- *",
      "rm -r -f *.log",
      "rm -rf .*",
      "rm -fr .*",
      "rm --recursive .*",
      "rm -rf ./.*",
      "rm -rf ../*",
      "rm -rf ../../*",
      "rm -rf ../.*",
      "rm -rf -- ../*",
      "rm -rf .[!.]*",
      "rm -rf .??*",
      "rm -rf '.*'",
      'rm -rf ".*"',
      "rm -rf dist .*",
      "rm -rf {*,.*}",
      "rm -rf {.,}*",
      "rm -rf ./{*,.*}",
      "rm -rf .{git,}",
      "rm -rf .{a,b}*",
      "rm -rf {dist,build}*",
      "rm -rf ./{dist,}",
      "rm -rf a*",
      "rm -rf dist*",
      "rm -rf node_modules*",
      "rm -rf .git*",
      "rm -rf .env*",
      "rm -rf id_rsa*",
      "rm -rf ./a*",
      "rm -rf ./build-*",
      "rm -rf ../dist*",
      "rm -rf a[ab]",
      "rm -rf a?",
      "rm -rf 'dist*'",
      "rm -rf dist.{a,b}*",
      "rm -rf a* b* c*",
      "rm -rf src dist*",
      "rm -rf */",
      "rm -rf '*/'",
      "rm -rf ../*/",
      "rm -rf .//*",
      "rm -rf ..//*",
      "rm -rf .///*",
      "rm -rf ..//.*",
      "rm -rf .//.*",
      "rm -rf .//dist*",
      "rm -rf './/*'",
      'rm -rf ".//*"',
    ])("%s is uncertain", (command) => {
      expect(classify(command)).toBe("uncertain");
    });
  });

  describe("scoped recursive deletes are not flagged as cwd deletes", () => {
    test.each([
      "rm -rf ./dist",
      "rm -rf ../dist",
      "rm -rf ../../dist",
      "rm -rf .//dist",
      "rm -rf ..//dist",
      "rm -rf dist//*.map",
      "rm -rf .cache",
      "rm -rf '.cache'",
      "rm -rf dist",
      "rm -rf dist/*.map",
      "rm -rf node_modules/*",
      "rm -rf ..cache",
      "rm -rf {dist,build}",
      "rm -rf dist/{a,b}",
      "rm -rf **/node_modules",
      "rm -rf */dist",
      "rm -rf */node_modules",
      "rm -rf **/*.map",
      "rm -rf ./*/dist",
      "rm -rf ./*/build",
      "rm -rf ../*/dist",
      "rm -rf packages/*/dist",
      "rm -rf {*,.*}/dist",
      "rm -rf dist*/cache",
      "rm -rf ./build-*/out",
      "rm -rf a[ab]/dist",
      "rm -rf dist{a,b}",
      "rm -rf dist{,old}",
      "rm -rf dist-old",
      "rm -rf .git-old",
    ])("%s is not uncertain", (command) => {
      expect(classify(command)).not.toBe("uncertain");
    });
  });

  describe("rm as a package manager subcommand or git rm --cached is not a recursive delete", () => {
    test.each([
      "git rm -r --cached .",
      "git rm --cached -r .",
      "git rm -r --cached *",
      "git   rm   -r   --cached   .",
      "git -C sub rm --cached -r .",
      "git --no-pager rm --cached -r .",
      "git -C packages/wt rm -r --cached *",
      "pnpm rm -r .",
      "pnpm  rm -r .",
      "npm rm -r .",
      "yarn rm -r .",
      "bun rm -r .",
      "env pnpm rm -r .",
      "sudo npm rm -r .",
    ])("%s is not matched by the recursive rules", (command) => {
      expect(checkKnownPatterns(command, context)?.reason ?? "").not.toMatch(/Recursive delete/);
    });
  });

  describe("git rm without --cached deletes from the working tree", () => {
    test.each(["git rm -rf .", "git rm -r .", "git rm -rf ./*", "env git rm -rf ."])(
      "%s is uncertain",
      (command) => {
        expect(classify(command)).toBe("uncertain");
      },
    );
  });

  describe("a token that merely ends with a package manager name does not exclude rm", () => {
    test.each([
      "x=npm rm -rf .",
      "env BUN=bun rm -rf .",
      "env NPM=npm rm -rf *",
      "PATH=/opt/bun rm -rf .",
      "FOO=bar rm -rf .",
    ])("%s is uncertain", (command) => {
      expect(classify(command)).toBe("uncertain");
    });

    // Neither is an `rm` at command position: `bin/bun` is an unknown command (delegated to
    // Haiku) and `./bun` is treated as dot-sourcing by the command parser (also delegated).
    // Neither may ever be auto-approved.
    test.each(["bin/bun rm -rf .", "./bun rm -rf ."])("%s is not safe", (command) => {
      expect(classify(command)).not.toBe("safe");
    });
  });

  describe("rm that is not the command word is not a recursive delete", () => {
    test("echo pnpm rm -rf . only prints", () => {
      expect(classify("echo pnpm rm -rf .")).toBe("safe");
    });
  });

  describe("quoting does not hide a recursive delete", () => {
    test.each([
      "rm '-rf' *",
      'rm "-rf" *',
      "rm -'r'f *",
      "rm -r'f' *",
      'rm -rf "./"*',
      'rm -rf "."/*',
      "rm -rf '.'*",
      'env "rm" -rf *',
      "env 'rm' -rf .*",
      "\\rm -rf .",
      "/bin/rm -rf .",
    ])("%s is uncertain", (command) => {
      expect(classify(command)).toBe("uncertain");
    });
  });

  describe("operands that resolve back to the current directory", () => {
    test.each(["rm -rf dist/..", "rm -rf a/../*", "rm -rf */..", "rm -rf {.,dist}"])(
      "%s is uncertain",
      (command) => {
        expect(classify(command)).toBe("uncertain");
      },
    );
  });

  describe("prefixed and chained rm still match", () => {
    test.each(["sudo rm -rf .", "cd x && rm -rf .", "env rm -rf *", "ls; rm -rf ./.*"])(
      "%s is uncertain",
      (command) => {
        expect(classify(command)).toBe("uncertain");
      },
    );
  });

  describe("rm that only appears inside a quoted string is not a recursive delete", () => {
    test.each([
      'git commit -m "guard rm -rf * now"',
      'git commit -m "fix(cc-tool-guard): never auto-approve rm -rf ."',
      "echo 'cleanup: rm -rf *'",
      "grep -rn 'rm -rf .' src",
      "grep -rn 'rm -rf .//*' src",
    ])("%s is safe", (command) => {
      expect(classify(command)).toBe("safe");
    });

    test("sh -c 'rm -rf .' is not auto-approved", () => {
      expect(classify("sh -c 'rm -rf .'")).not.toBe("safe");
    });
  });

  test("a 200 KB command evaluates well within budget", () => {
    const size = 200_000;
    const paths = Array.from({ length: 10_000 }, (_, i) => `path/to/file-${i}.txt`).join(" ");
    const spaces = " ".repeat(size);
    const slashes = "/".repeat(size);
    const commands = [
      `rm -rf ${paths}`,
      `cp ${paths} dest`,
      `git rm -r --cached ${paths}`,
      `echo${spaces}rm -rf ${paths}`,
      `rm -r ${"{a ".repeat(size / 3)}}`,
      `rm -r ${"{a, ".repeat(size / 4)}}`,
      `rm -rf ..${slashes}`,
      `rm -rf ..${slashes}*`,
      `rm -rf ${"./".repeat(size / 2)}dist`,
      `rm -rf ${"../".repeat(size / 3)}*`,
      `rm -rf ${"a/../".repeat(size / 5)}*`,
      `rm -rf "${"./".repeat(size / 2)}"dist`,
    ];
    for (const command of commands) {
      expect(command.length).toBeGreaterThan(size);
      const start = performance.now();
      checkKnownPatterns(command, context);
      expect(performance.now() - start).toBeLessThan(50);
    }
  });

  test("non-recursive rm of a glob is not matched by the recursive rules", () => {
    const result = checkKnownPatterns("rm *.log", context);
    expect(result?.reason).not.toMatch(/Recursive/);
  });
});

describe("package runner commands are not auto-approved", () => {
  test.each(["npx some-package", "bun x some-package"])("%s is not safe", (command) => {
    expect(classify(command)).not.toBe("safe");
  });

  test("bun run is still safe", () => {
    expect(classify("bun run build")).toBe("safe");
  });
});
