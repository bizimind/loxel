/**
 * Rate a light-theme screenshot with two independent judges, Claude Opus (`claude -p`) and Codex
 * (`codex exec`), in parallel: `bun e2e/theme/rate.ts <panel> <shot.png> <out.json>`.
 * Writes `{ panel, image, opus, codex, min }`, each judge giving `{ score, summary, issues }`.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { $ } from "bun";

import type { PanelShot } from "./lib";

const [panel, imageArg, outArg] = process.argv.slice(2);
if (!panel || !imageArg || !outArg) {
  throw new Error("usage: bun e2e/theme/rate.ts <panel> <shot.png> <out.json>");
}
const image = resolve(imageArg);
const out = resolve(outArg);
const shot = (
  (await import(resolve(import.meta.dirname, "panels", `${panel}.ts`))) as { default: PanelShot }
).default;

const RUBRIC = `You are judging the LIGHT THEME of one area of Loxel, a desktop IDE (Electron, dark by default).
The screenshot shows: ${shot.description}.
The app is set to the light theme. Judge only how well this area works and looks in light mode.

Score 0-10:
- 0: unusable in light mode (unreadable text, invisible content).
- 1-3: mostly still dark, or light and dark mixed in broken ways (dark editor/terminal/panel inside a light app, white-on-white or black-on-black text).
- 4-5: mostly light but with clear broken spots (some region still dark, illegible elements, wrong-theme widgets).
- 6: light mode works with several noticeable flaws.
- 7: works; only contrast issues (faint text, low-contrast borders, washed-out highlights or selection).
- 8-9: purely aesthetic nitpicks remain (spacing of tones, slightly off accent, minor inconsistency).
- 10: a beautiful, polished, coherent light theme.
Half points (for example 7.5 or 8.5) are allowed.

Look closely at every region: text contrast, syntax colors, selection/hover/active states, borders, badges, icons, scrollbars, code blocks, gutters, diff colors, and anything that still looks dark.
Respond with ONLY a JSON object, no prose, no code fence:
{"score": <number 0-10 in steps of 0.5>, "summary": "<one sentence>", "explanation": "<a detailed explanation of the score: what earns it, and what specifically keeps it from scoring higher>", "issues": ["<specific issue: where, what is wrong, what it should be>", ...]}`;

interface Verdict {
  score: number;
  summary: string;
  explanation: string;
  issues: string[];
}

function parseVerdict(raw: string): Verdict {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`no JSON in judge output: ${raw.slice(0, 300)}`);
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<Verdict>;
  if (typeof parsed.score !== "number") throw new Error(`no score in: ${raw.slice(0, 300)}`);
  return {
    score: parsed.score,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    explanation: typeof parsed.explanation === "string" ? parsed.explanation : "",
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
  };
}

async function rateWithOpus(): Promise<Verdict> {
  const prompt = `${RUBRIC}\n\nThe screenshot is at ${image}. Read it with the Read tool, then answer.`;
  const res =
    await $`claude -p --model claude-opus-5-5 --allowedTools Read --output-format json ${prompt}`
      .cwd(tmpdir())
      .quiet();
  const envelope = JSON.parse(res.stdout.toString()) as { result?: string };
  return parseVerdict(envelope.result ?? "");
}

async function rateWithCodex(): Promise<Verdict> {
  const dir = mkdtempSync(join(tmpdir(), "theme-rate-"));
  const last = join(dir, "last.txt");
  // `-i` takes several files, so the prompt goes in on stdin rather than as an argument.
  const proc = Bun.spawn(
    ["codex", "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only"].concat([
      "-i",
      image,
      "-o",
      last,
      "-",
    ]),
    { cwd: dir, stdin: new Blob([RUBRIC]), stdout: "ignore", stderr: "pipe" },
  );
  if ((await proc.exited) !== 0) {
    throw new Error(
      `codex exited ${proc.exitCode}: ${(await new Response(proc.stderr).text()).slice(-500)}`,
    );
  }
  return parseVerdict(readFileSync(last, "utf8"));
}

async function safely(judge: () => Promise<Verdict>): Promise<Verdict | { error: string }> {
  try {
    return await judge();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const [opus, codex] = await Promise.all([safely(rateWithOpus), safely(rateWithCodex)]);
const scores = [opus, codex].flatMap((v) => ("score" in v ? [v.score] : []));
const result = { panel, image, opus, codex, min: scores.length ? Math.min(...scores) : null };
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
