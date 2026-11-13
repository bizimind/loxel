/**
 * Records a real Claude Code TUI session for the agent overlay's fixtures: screens (plain text, as
 * the terminal host's `screen` command returns them), every hook payload, and the transcript.
 *
 *   bun scripts/capture-claude-tui.ts <out-dir> [--model haiku]
 *
 * Runs `claude` in a PTY in a fresh scratch directory under <out-dir>, drives it through the
 * interactive surfaces the overlay recognizes (trust dialog, permission prompt, AskUserQuestion,
 * permission-mode footer, plan approval), and writes `<step>.screen.txt` per step plus
 * `hooks.ndjson`. It makes a few short model turns, so it costs a few cents; run it only to
 * re-record fixtures after a Claude Code release changes its screens, then sanitize paths and
 * account details before committing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { Terminal as HeadlessTerminal } from "@xterm/headless";

const COLS = 120;
const ROWS = 40;

const [outArg, ...rest] = process.argv.slice(2);
if (!outArg) throw new Error("usage: bun scripts/capture-claude-tui.ts <out-dir> [--model haiku]");
const outDir = resolve(outArg);
const modelIndex = rest.indexOf("--model");
const model = modelIndex >= 0 ? rest[modelIndex + 1] : "haiku";
const workDir = join(outDir, "work");
mkdirSync(workDir, { recursive: true });

const hooksFile = join(outDir, "hooks.ndjson");
const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "SessionEnd",
];
const hookCommand = `{ cat; echo; } >> '${hooksFile}'`;
const settings = {
  hooks: Object.fromEntries(
    HOOK_EVENTS.map((event) => [event, [{ hooks: [{ type: "command", command: hookCommand }] }]]),
  ),
};
const settingsFile = join(outDir, "settings.json");
writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

const emulator = new HeadlessTerminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && key !== "CLAUDECODE" && !key.startsWith("CLAUDE_CODE")) {
    env[key] = value;
  }
}
env.TERM = "xterm-256color";

const proc = Bun.spawn(
  [
    "claude",
    "--model",
    model ?? "haiku",
    "--permission-mode",
    "default",
    "--settings",
    settingsFile,
  ],
  {
    cwd: workDir,
    env,
    terminal: { cols: COLS, rows: ROWS, data: (_terminal, data) => emulator.write(data) },
  },
);

/** The visible screen as plain text, once everything written so far has been parsed. */
function screen(): Promise<string> {
  return new Promise<string>((done) => {
    emulator.write("", () => {
      const buffer = emulator.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < emulator.rows; y++) {
        lines.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "");
      }
      done(lines.join("\n"));
    });
  });
}

function send(data: string): void {
  proc.terminal?.write(data);
}

async function waitFor(pattern: RegExp, timeoutMs = 90_000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const text = await screen();
    if (pattern.test(text)) return text;
    if (Date.now() - started > timeoutMs) {
      writeFileSync(join(outDir, "timeout.screen.txt"), text);
      throw new Error(`Timed out waiting for ${pattern}`);
    }
    await Bun.sleep(150);
  }
}

/** Waits until the screen stops changing for `quietMs`. */
async function settle(quietMs = 800): Promise<string> {
  let last = await screen();
  let since = Date.now();
  for (;;) {
    await Bun.sleep(100);
    const text = await screen();
    if (text !== last) {
      last = text;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return text;
    }
  }
}

async function capture(step: string): Promise<string> {
  const text = await settle();
  writeFileSync(join(outDir, `${step}.screen.txt`), text);
  console.log(`captured ${step}`);
  return text;
}

function paste(text: string): void {
  send(`\x1b[200~${text}\x1b[201~`);
}

const IDLE = /\? for shortcuts|shift\+tab to cycle|for shortcuts/;

try {
  const first = await waitFor(/trust|❯|for shortcuts/i, 60_000);
  if (/trust/i.test(first)) {
    await capture("01-trust-dialog");
    // The default choice is "No, exit".
    send("\x1b[B");
    await Bun.sleep(150);
    send("\r");
  }
  await waitFor(IDLE);
  await capture("02-idle");

  // Permission prompt for a Bash command.
  paste("Run exactly this bash command and nothing else: python3 -c 'print(6*7)'");
  await Bun.sleep(200);
  send("\r");
  await waitFor(/Do you want to proceed\?|Do you want/);
  await capture("03-permission-bash");
  send("\r");
  await waitFor(IDLE);
  await capture("04-after-permission");

  // AskUserQuestion with one question: no tabs, no review page.
  paste(
    "Use the AskUserQuestion tool once with exactly one question, header 'Size': 'Which size do you want?' options Small, Large (single select). After I answer, reply with my answer in one short line.",
  );
  await Bun.sleep(200);
  send("\r");
  await waitFor(/Which size do you want\?/);
  await capture("05a-question-single");
  send("\x1b[B");
  await Bun.sleep(150);
  await capture("05b-question-single-moved");
  send("\r");
  await waitFor(IDLE);
  await capture("05c-after-single-question");

  // AskUserQuestion with a single-select and a multi-select question.
  paste(
    "Use the AskUserQuestion tool once with two questions. Question 1, header 'Color': 'Which color do you prefer?' options Red, Blue (single select). Question 2, header 'Fruit': 'Which fruits do you like?' options Apple, Pear, Plum (multiSelect true). After I answer, reply with my answers in one short line.",
  );
  await Bun.sleep(200);
  send("\r");
  await waitFor(/Which color do you prefer\?/);
  await capture("05-question-1");
  send("\x1b[B");
  await Bun.sleep(150);
  send("\r");
  await waitFor(/Which fruits do you like\?/);
  await capture("06-question-2-multi");
  send(" ");
  await Bun.sleep(150);
  send("\x1b[B");
  await Bun.sleep(150);
  send("\x1b[B");
  await Bun.sleep(150);
  send(" ");
  await Bun.sleep(150);
  await capture("07-question-2-toggled");
  send("\t");
  await Bun.sleep(300);
  await capture("08-question-submit");
  send("\r");
  await waitFor(IDLE);
  await capture("09-after-question");

  // Permission-mode footers: cycle with Shift+Tab, capturing each.
  for (let i = 0; i < 4; i++) {
    send("\x1b[Z");
    await capture(`10-mode-${i}`);
  }
  // Get to plan mode.
  for (let i = 0; i < 6 && !/plan mode on/i.test(await screen()); i++) {
    send("\x1b[Z");
    await settle(400);
  }
  paste(
    "Plan how to create a file hello.txt containing the word hi. Keep the plan to two short lines and present it with ExitPlanMode right away, without exploring.",
  );
  await Bun.sleep(200);
  send("\r");
  await waitFor(/Would you like to proceed\?|ready to code|proceed/i);
  await capture("11-plan-approval");
  // Revise: the last choice takes typed feedback.
  send("\x1b[B");
  await Bun.sleep(150);
  send("\x1b[B");
  await capture("11b-plan-revise-selected");
  paste("Use printf in Bash instead.");
  await capture("11c-plan-revise-typed");
  send("\r");
  await waitFor(/Would you like to proceed\?|for shortcuts/i, 90_000);
  await capture("12-after-plan-revise");
  send("\x1b");
  await capture("12b-after-plan-escape");
  await waitFor(IDLE, 30_000).catch(() => undefined);

  // Slash menu, for reference.
  send("/");
  await capture("13-slash-menu");
  send("\x15");
  send("\x1b");
} finally {
  await capture("99-final").catch(() => "");
  send("\x03");
  await Bun.sleep(300);
  send("\x03");
  await Bun.sleep(500);
  proc.kill();
  emulator.dispose();
}
