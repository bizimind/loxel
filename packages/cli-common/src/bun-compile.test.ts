import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BUN_COMPILE = path.join(import.meta.dirname, "bun-compile.ts");
const COMPILE_TIMEOUT_MS = 60_000;

let work = "";
/** A folder holding a `bunfig.toml` with a preload and a `.env`, the binaries' working directory. */
let project = "";

function compile(command: string[]): void {
  const built = Bun.spawnSync(command, { cwd: work, stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
}

function runInProject(binary: string): string[] {
  const run = Bun.spawnSync([path.join(work, binary)], { cwd: project, env: {}, stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim().split("\n");
}

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "bun-compile-"));
  writeFileSync(
    path.join(work, "probe.ts"),
    `console.log("main " + (process.env.BUN_COMPILE_PROBE ?? "unset"));\n`,
  );
  project = path.join(work, "project");
  mkdirSync(project);
  writeFileSync(path.join(project, "bunfig.toml"), `preload = ["./preload.js"]\n`);
  writeFileSync(path.join(project, "preload.js"), `console.log("preload");\n`);
  writeFileSync(path.join(project, ".env"), "BUN_COMPILE_PROBE=from-dotenv\n");

  compile([process.execPath, BUN_COMPILE, "probe.ts", "--outfile", "shared-flags"]);
  // Bun's defaults, to show the project folder is one a compiled binary would otherwise pick up.
  compile([process.execPath, "build", "--compile", "probe.ts", "--outfile", "defaults"]);
}, COMPILE_TIMEOUT_MS);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe("bun-compile", () => {
  test("a binary it builds ignores bunfig.toml and .env in its working directory", () => {
    expect(runInProject("shared-flags")).toEqual(["main unset"]);
  });

  // Fails if a Bun upgrade turns these autoloads off by default, not if the helper broke.
  test("a binary built with Bun's defaults reads both from the same folder", () => {
    expect(runInProject("defaults")).toEqual(["preload", "main from-dotenv"]);
  });
});
