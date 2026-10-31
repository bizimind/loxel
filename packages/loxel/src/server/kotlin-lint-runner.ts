import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord } from "@/lib/is-record";

import { NO_JAVA, trustedPath } from "./kotlin-formatter";
import type { DetektProject, KotlinLintProject, KotlinLintTool } from "./kotlin-lint-config";
import { logger } from "./logger";
import { buildSpawnEnv } from "./shell-env";

const log = logger.child("kotlin-lint-lsp");

/** A JVM may be slow on a busy machine; past this something is wrong, and a later save tries again. */
const RUN_TIMEOUT_MS = 60_000;
/** A failure notice longer than this is cut; the log has all of it. */
const MAX_FAILURE_LENGTH = 600;
/** detekt's exit when it reports issues; ktlint uses 1 for that and for a crash. */
const DETEKT_FOUND_ISSUES = 2;

const SEVERITY = { error: 1, warning: 2, note: 3 } as const;
const COMMANDS: Record<KotlinLintTool, readonly string[]> = {
  // Homebrew installs `detekt`, the release archive's launcher is `detekt-cli`.
  detekt: ["detekt", "detekt-cli"],
  ktlint: ["ktlint"],
};
const DETEKT_RULE_DOCS = "https://detekt.dev/docs/rules";
const KTLINT_RULE_DOCS = "https://ktlint.github.io/ktlint/latest/rules/standard/";

export interface KotlinLintDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity: (typeof SEVERITY)[keyof typeof SEVERITY];
  source: KotlinLintTool;
  message: string;
  code?: string;
  codeDescription?: { href: string };
}

type KotlinLintFailure =
  | { kind: "not-installed" }
  | { kind: "no-java" }
  | { kind: "failed"; message: string }
  | { kind: "stopped" };

export type KotlinLintOutcome =
  | { kind: "reported"; diagnostics: Map<string, KotlinLintDiagnostic[]> }
  | KotlinLintFailure;

interface Tool {
  executable: string;
  path: string;
}

interface ToolExit {
  /** Null when a signal ended it. */
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Lint `files` of `project`, from the machine's tool. The tool comes from the same `PATH` as format
 * on save, and it runs from the home directory, where a version manager's shim cannot take its
 * version from a `.tool-versions` the repository ships. No flag here is derived from a repository
 * file except the config path and the files: `--plugins`, `--classpath`, `--ruleset` and
 * `--baseline` would load or parse more of it.
 */
export async function runKotlinLint(
  project: KotlinLintProject,
  files: readonly string[],
  wtRoot: string,
  signal: AbortSignal,
): Promise<KotlinLintOutcome> {
  const tool = await findTool(project.tool, wtRoot);
  if (!tool) return { kind: "not-installed" };
  const reportDir = await mkdtemp(join(tmpdir(), "loxel-kotlin-lint-"));
  try {
    return project.tool === "detekt"
      ? await runDetekt(tool, project, files, reportDir, signal)
      : await runKtlint(tool, files, reportDir, signal);
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
}

async function findTool(name: KotlinLintTool, wtRoot: string): Promise<Tool | null> {
  const root = resolve(wtRoot);
  for (const command of COMMANDS[name]) {
    const path = await trustedPath(command, root);
    const executable = Bun.which(command, { PATH: path });
    if (executable) return { executable, path };
  }
  return null;
}

async function runDetekt(
  tool: Tool,
  project: DetektProject,
  files: readonly string[],
  reportDir: string,
  signal: AbortSignal,
): Promise<KotlinLintOutcome> {
  const major = await detektMajorVersion(tool, signal);
  if (typeof major !== "number") return major;
  const report = join(reportDir, "detekt.sarif");
  const inputs = major < 2 ? files.filter((file) => !LIST_SEPARATOR.test(file)) : files;
  if (inputs.length === 0) return { kind: "reported", diagnostics: new Map() };
  if (major < 2 && project.configs.some((config) => LIST_SEPARATOR.test(config))) {
    return {
      kind: "failed",
      message: "detekt 1.x can't read a config whose path has a comma or semicolon.",
    };
  }
  const configs =
    project.configs.length > 0 ? [...project.configs, await writeValidationOff(reportDir)] : [];
  const exit = await spawnTool(
    tool,
    [
      ...listOption("--input", inputs, major),
      ...listOption("--config", configs, major),
      ...(configs.length > 0 && project.buildUponDefaultConfig
        ? ["--build-upon-default-config"]
        : []),
      ...(project.allRules ? ["--all-rules"] : []),
      "--base-path",
      project.root,
      "--report",
      `sarif:${report}`,
    ],
    signal,
  );
  const failure = exitFailure(exit, signal);
  if (failure) return failure;
  const diagnostics =
    exit.exitCode === 0 || exit.exitCode === DETEKT_FOUND_ISSUES
      ? parseSarif(await readReport(report), project.root)
      : null;
  if (diagnostics) return { kind: "reported", diagnostics };
  // A version switch behind the same path fails this way, so the next run reads it again.
  detektMajors.delete(tool.executable);
  return failed(exit);
}

/**
 * Plugin rule sets don't run here, so a config that sets them would fail detekt's validation
 * (exit 3) although the project's own build accepts it. A later `--config` wins.
 */
async function writeValidationOff(reportDir: string): Promise<string> {
  const path = join(reportDir, "no-validation.yml");
  await Bun.write(path, "config:\n  validation: false\n");
  return path;
}

/** detekt 1.x takes one comma-separated value, and splits on `,` and `;`; 2.x repeats the flag. */
function listOption(flag: string, values: readonly string[], major: number): string[] {
  if (values.length === 0) return [];
  return major < 2 ? [flag, values.join(",")] : values.flatMap((value) => [flag, value]);
}

/** Cached per installed binary: its version is a JVM start of its own. */
const detektMajors = new Map<string, number>();
const LIST_SEPARATOR = /[,;]/;

async function detektMajorVersion(
  tool: Tool,
  signal: AbortSignal,
): Promise<number | KotlinLintFailure> {
  const cached = detektMajors.get(tool.executable);
  if (cached !== undefined) return cached;
  const exit = await spawnTool(tool, ["--version"], signal);
  const failure = exitFailure(exit, signal);
  if (failure) return failure;
  // Stdout alone: a JVM can print to stderr first ("Picked up JAVA_TOOL_OPTIONS").
  const major = /^\s*(\d+)\./.exec(exit.stdout)?.[1];
  if (!major) return failed(exit);
  detektMajors.set(tool.executable, Number(major));
  return Number(major);
}

async function runKtlint(
  tool: Tool,
  files: readonly string[],
  reportDir: string,
  signal: AbortSignal,
): Promise<KotlinLintOutcome> {
  // A file, not stdout or stderr: which of them the JSON reporter uses has varied.
  const report = join(reportDir, "ktlint.json");
  const exit = await spawnTool(
    tool,
    [`--reporter=json,output=${report}`, "--log-level=none", ...files],
    signal,
  );
  const failure = exitFailure(exit, signal);
  if (failure) return failure;
  // Exit 1 is violations or a crash; only the former leaves a complete report.
  const diagnostics = parseKtlintJson(await readReport(report));
  return diagnostics ? { kind: "reported", diagnostics } : failed(exit);
}

/**
 * Runs in a process group of its own, which a timeout or the session's end kills whole: a launcher
 * that forks would otherwise leave the JVM running, holding the pipes this waits on.
 */
async function spawnTool(tool: Tool, args: string[], signal: AbortSignal): Promise<ToolExit> {
  if (signal.aborted) return { exitCode: null, timedOut: false, stdout: "", stderr: "" };
  const proc = Bun.spawn([tool.executable, ...args], {
    cwd: homedir(),
    env: { ...buildSpawnEnv(), PATH: tool.path },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const killGroup = (): void => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch (err) {
      log.debug("Kotlin lint tool had already exited", { error: err });
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, RUN_TIMEOUT_MS);
  signal.addEventListener("abort", killGroup, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode: proc.signalCode ? null : exitCode, timedOut, stdout, stderr };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", killGroup);
  }
}

/** The outcome of an exit that says nothing about the code: stopped, or no JVM to start. */
function exitFailure(exit: ToolExit, signal: AbortSignal): KotlinLintFailure | null {
  if (signal.aborted) return { kind: "stopped" };
  if (exit.timedOut) {
    return { kind: "failed", message: `it did not finish in ${RUN_TIMEOUT_MS / 1_000} s.` };
  }
  return NO_JAVA.test(exit.stderr) || NO_JAVA.test(exit.stdout) ? { kind: "no-java" } : null;
}

function failed(exit: ToolExit): KotlinLintFailure {
  // Without colors, and without a JVM stack trace.
  const message = Bun.stripANSI(`${exit.stderr}\n${exit.stdout}`)
    .split("\n")
    .filter((line) => !/^\s+at /.test(line))
    .join("\n")
    .trim();
  if (!message) {
    const ending = exit.exitCode === null ? "a signal" : `exit code ${exit.exitCode}`;
    return { kind: "failed", message: `it ended with ${ending} and no message.` };
  }
  return {
    kind: "failed",
    message:
      message.length > MAX_FAILURE_LENGTH ? `${message.slice(0, MAX_FAILURE_LENGTH)}…` : message,
  };
}

async function readReport(path: string): Promise<unknown> {
  try {
    return JSON.parse(await Bun.file(path).text());
  } catch {
    return null;
  }
}

/**
 * detekt's SARIF. Severity is a result's `level`, else its rule's default (2.x leaves `level` out),
 * else SARIF's own default, `warning`. Null when `report` is not a SARIF log.
 */
export function parseSarif(
  report: unknown,
  basePath: string,
): Map<string, KotlinLintDiagnostic[]> | null {
  if (!isRecord(report) || !Array.isArray(report.runs)) return null;
  const diagnostics = new Map<string, KotlinLintDiagnostic[]>();
  for (const run of report.runs) {
    if (!isRecord(run) || !Array.isArray(run.results)) continue;
    const levels = ruleLevels(run);
    for (const result of run.results) {
      const location = sarifLocation(result, basePath);
      if (!isRecord(result) || !location) continue;
      const ruleId = typeof result.ruleId === "string" ? result.ruleId : "";
      const message = isRecord(result.message) ? result.message.text : null;
      if (typeof message !== "string") continue;
      const level = result.level ?? levels.get(ruleId);
      add(diagnostics, location.file, {
        range: location.range,
        severity: SEVERITY[isSeverityName(level) ? level : "warning"],
        source: "detekt",
        message,
        ...detektRule(ruleId),
      });
    }
  }
  return diagnostics;
}

function ruleLevels(run: Record<string, unknown>): Map<string, unknown> {
  const levels = new Map<string, unknown>();
  const driver = isRecord(run.tool) ? run.tool.driver : null;
  const rules = isRecord(driver) && Array.isArray(driver.rules) ? driver.rules : [];
  for (const rule of rules) {
    if (!isRecord(rule) || typeof rule.id !== "string") continue;
    const defaults = rule.defaultConfiguration;
    if (isRecord(defaults)) levels.set(rule.id, defaults.level);
  }
  return levels;
}

function sarifLocation(
  result: unknown,
  basePath: string,
): { file: string; range: KotlinLintDiagnostic["range"] } | null {
  const location =
    isRecord(result) && Array.isArray(result.locations) ? result.locations[0] : undefined;
  const physical = isRecord(location) ? location.physicalLocation : null;
  const artifact = isRecord(physical) ? physical.artifactLocation : null;
  const uri = isRecord(artifact) ? artifact.uri : null;
  if (typeof uri !== "string") return null;
  const region = isRecord(physical) && isRecord(physical.region) ? physical.region : {};
  const startLine = positive(region.startLine, 1);
  const startColumn = positive(region.startColumn, 1);
  return {
    file: uri.startsWith("file:") ? fileURLToPath(uri) : resolve(basePath, uri),
    range: {
      start: { line: startLine - 1, character: startColumn - 1 },
      // SARIF's end column is past the last character, like LSP's.
      end: {
        line: positive(region.endLine, startLine) - 1,
        character: positive(region.endColumn, startColumn) - 1,
      },
    },
  };
}

/** `detekt.<rule set>.<Rule>`, as SARIF names it; its page and anchor follow from that. */
function detektRule(ruleId: string): Pick<KotlinLintDiagnostic, "code" | "codeDescription"> {
  const [prefix, ruleSet, rule] = ruleId.split(".");
  if (prefix !== "detekt" || !ruleSet || !rule) return ruleId ? { code: ruleId } : {};
  return {
    code: rule,
    codeDescription: { href: `${DETEKT_RULE_DOCS}/${ruleSet}#${rule.toLowerCase()}` },
  };
}

/**
 * ktlint's JSON report. It has no severity field; its checkstyle report says `error` for every
 * violation, and any violation fails the run, so that is what they are here too. Null when `report`
 * is not one: a crash leaves no report. A syntax error comes as an entry with an empty rule.
 */
export function parseKtlintJson(report: unknown): Map<string, KotlinLintDiagnostic[]> | null {
  if (!Array.isArray(report)) return null;
  const diagnostics = new Map<string, KotlinLintDiagnostic[]>();
  for (const entry of report) {
    if (!isRecord(entry) || typeof entry.file !== "string" || !Array.isArray(entry.errors))
      continue;
    // It is given absolute paths and reports them as given.
    if (!isAbsolute(entry.file)) continue;
    const file = entry.file;
    for (const error of entry.errors) {
      if (!isRecord(error) || typeof error.message !== "string") continue;
      const position = {
        line: positive(error.line, 1) - 1,
        character: positive(error.column, 1) - 1,
      };
      const rule = typeof error.rule === "string" ? error.rule : "";
      add(diagnostics, file, {
        // ktlint gives a point; Monaco widens an empty range to the word there.
        range: { start: position, end: position },
        severity: SEVERITY.error,
        source: "ktlint",
        message: error.message,
        ...ktlintRule(rule),
      });
    }
  }
  return diagnostics;
}

/** The standard rule set's one documentation page: its anchors follow titles, not rule ids. */
function ktlintRule(rule: string): Pick<KotlinLintDiagnostic, "code" | "codeDescription"> {
  if (!rule) return {};
  return rule.startsWith("standard:")
    ? { code: rule, codeDescription: { href: KTLINT_RULE_DOCS } }
    : { code: rule };
}

function add<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function isSeverityName(level: unknown): level is keyof typeof SEVERITY {
  return level === "error" || level === "warning" || level === "note";
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && value >= 1 ? value : fallback;
}
