#!/usr/bin/env bun
import type { AgentOrigin } from "./api/agent-terminal-model";
import { parseOpenArgs, parseTerminalArgs, planOpens } from "./cli-args";
import { codingAgentName, isCodingAgent } from "./coding-agent-env";
import { SOCKET_URL, findServer, givenServerGone, waitForServer } from "./find-server";
import { WINDOW_WAIT_MS, requestOpenAll } from "./open-request";
import { isHttpUrl } from "./url-utils";

/**
 * The exit status when an agent's terminal waits for the user's answer in Loxel ("When an Agent
 * Starts a Terminal" is Ask): nothing started, and nothing failed either.
 */
const ASKED_EXIT_CODE = 3;

async function detectWorktree(dir: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Not inside a git repository: ${dir}`);
  }
  const stdout = await new Response(proc.stdout).text();
  return stdout.trim();
}

/** Launch Loxel, or bring it to the front if it is running; `-g` launches it in the background. */
function launchLoxel({ background = false } = {}): void {
  const args = background ? ["open", "-g", "-a", "Loxel"] : ["open", "-a", "Loxel"];
  Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // No arguments: focus/launch loxel
  if (args.length === 0) {
    launchLoxel();
    return;
  }

  // `loxel terminal ...` opens a terminal panel, anything else files, folders and URLs. Parsed first
  // so bad flags fail before any launch.
  const parsed =
    args[0] === "terminal"
      ? parseTerminalArgs(args.slice(1), process.cwd())
      : parseOpenArgs(args, process.cwd());
  // Focus follows the caller unless a flag says otherwise: a coding agent's opens must not pull
  // the user away from what they are looking at, while a user's own opens show what they asked for.
  const codingAgent = isCodingAgent(process.env);
  const focus = parsed.focus ?? !codingAgent;

  // Check env vars (inside loxel terminal)
  const isInsideLoxel = process.env.LOXEL === "1";
  const envWorktree = process.env.LOXEL_WORKTREE;
  const envWindowId = process.env.LOXEL_WINDOW_ID;

  const targets = "targets" in parsed ? parsed.targets : [];
  const urlCount = targets.filter((target) => isHttpUrl(target)).length;
  // One worktree for the whole command: --worktree, else, for a command with a URL, the CWD's.
  // Inside a loxel terminal, fall back to LOXEL_WORKTREE when the CWD is outside any git repo. A
  // command of only files needs none: each file opens in its own worktree.
  const pinnedWorktree = parsed.worktree ? await detectWorktree(parsed.worktree) : null;
  let commandWorktree = pinnedWorktree;
  // A Home terminal has a window but no worktree: its pages open in what that window shows.
  let urlsToWindow = false;
  let urlError: string | null = null;
  if (!commandWorktree && urlCount > 0) {
    try {
      commandWorktree = await detectWorktree(process.cwd());
    } catch (err) {
      if (isInsideLoxel && envWorktree) commandWorktree = envWorktree;
      else if (isInsideLoxel && envWindowId) urlsToWindow = true;
      // With nothing else to open, fail before launching anything.
      else if (urlCount === targets.length) throw err;
      else urlError = err instanceof Error ? err.message : String(err);
    }
  }

  let announced = false;
  const announceWaiting = () => {
    if (!announced) process.stderr.write("loxel: waiting for a Loxel window...\n");
    announced = true;
  };

  // Find the server, and bring Loxel to the front or launch it; without focus, only launch it, in
  // the background. A server a Loxel terminal names belongs to the window the terminal is in, so
  // it is not focused, and is launched (in the background) only when it is gone for good (#1387).
  const found = await findServer(process.env);
  const launched = found?.given
    ? await givenServerGone(found.socket, { onWaiting: announceWaiting })
    : focus || !found;
  if (launched) launchLoxel({ background: found?.given === true || !focus });
  const socket =
    found?.socket ?? (await waitForServer(process.env, { onWaiting: announceWaiting }));

  // The window in use: from a loxel terminal, that terminal's window; otherwise the focused one.
  const windowId = isInsideLoxel && envWindowId ? envWindowId : undefined;
  const options = { focus, ...(windowId ? { windowId } : {}) };
  const pin = pinnedWorktree ? { pinWtPath: pinnedWorktree } : {};
  // A coding agent's terminal says which agent asked, and from which Loxel terminal: Loxel's
  // setting decides whether it runs, and its tab says where it came from.
  const terminalId = process.env.LOXEL_TERMINAL_ID;
  const agentName = codingAgentName(process.env);
  const agent: AgentOrigin | null = codingAgent
    ? {
        ...(agentName ? { agent: agentName } : {}),
        ...(isInsideLoxel && terminalId ? { terminalId } : {}),
        ...(isInsideLoxel && envWorktree ? { worktreePath: envWorktree } : {}),
      }
    : null;
  const opens =
    "terminal" in parsed
      ? [
          {
            label: "",
            request: {
              terminal: parsed.terminal,
              placement: parsed.placement,
              ...pin,
              ...options,
              ...(agent ? { agent } : {}),
            },
          },
        ]
      : planOpens(parsed, {
          baseDir: process.cwd(),
          pinnedWorktree,
          commandWorktree,
          urlsToWindow,
          options,
        });
  for (const { label } of opens.filter((open) => !open.request)) {
    process.stderr.write(`loxel: ${label}${urlError}\n`);
  }
  const sendable = opens.flatMap(({ label, request }) => (request ? [{ label, request }] : []));

  // Launching Loxel brings a window (one starts with the app, and activating it opens one), so the
  // opens wait for it as long as a cold start takes. Otherwise none is coming: with no window open,
  // they wait in Loxel's inbox for the next one instead.
  const { warnings, queued, asked, failures } = await requestOpenAll(
    SOCKET_URL,
    sendable.map((open) => open.request),
    { unix: socket, onWaiting: announceWaiting, queueAfterMs: launched ? WINDOW_WAIT_MS : 0 },
  );
  for (const warning of warnings) process.stderr.write(`loxel: warning: ${warning}\n`);
  if (asked > 0) {
    // Only `loxel terminal` is asked about, and it sends one request.
    const where =
      queued > 0
        ? "No Loxel window is open: the next one to open asks the user."
        : "Loxel is asking the user now.";
    process.stderr.write(
      `loxel: Loxel asks the user before a coding agent starts a terminal. ${where} The terminal has not started, and starts only if they choose Run. Do not retry unless the user asks you to: tell them it waits for their answer in Loxel.\n`,
    );
    process.exitCode = ASKED_EXIT_CODE;
  } else if (queued > 0) {
    const all = queued === sendable.length;
    const what = all ? (queued === 1 ? "this" : "these") : `${queued} of these`;
    process.stderr.write(
      `loxel: no Loxel window is open; ${what} will open in the next window to connect\n`,
    );
  }
  for (const { index, message } of failures) {
    process.stderr.write(`loxel: ${sendable[index]!.label}${message}\n`);
  }
  if (urlError || failures.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`loxel: ${message}\n`);
  process.exit(1);
});
