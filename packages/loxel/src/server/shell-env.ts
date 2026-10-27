import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { logger } from "./logger";

const log = logger.child("server");

/** How long server startup waits for {@link resolveLoginShellEnv} before serving without it. */
export const LOGIN_SHELL_ENV_WAIT_MS = 2000;

/** How long a login shell may take before it is killed and the inherited environment kept. */
const CAPTURE_TIMEOUT_MS = 10_000;
/**
 * A missed lookup re-captures at most this often. Each capture runs the user's startup files,
 * daemons they launch included (an `eval "$(ssh-agent -s)"` starts another agent), so captures are
 * kept rare: there is no periodic refresh, and a tool that stays missing does not re-run them on
 * every lookup.
 */
const MIN_REFRESH_INTERVAL_MS = 5 * 60_000;

/** Shell session state rather than configuration; never copied from the captured environment. */
const SESSION_VARS = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);

type Env = Record<string, string | undefined>;

export interface LoginShellEnvOptions {
  /** The shell to run; defaults to `$SHELL` (else `/bin/zsh`) at capture time. */
  shell?: string;
  timeoutMs?: number;
  minRefreshIntervalMs?: number;
}

/** Called with the names of the variables whose captured value changed, appeared or went away. */
export type LoginShellEnvListener = (changedNames: ReadonlySet<string>) => void;

/**
 * The variables the user's login shell sets or changes relative to the environment it was started
 * with, captured by running `$SHELL -l -i -c` once at startup and again when a lookup misses.
 *
 * macOS apps launched from Finder or the Dock inherit a minimal launchd environment that lacks
 * what `.zshrc` / `.bash_profile` / `config.fish` export (PATH additions from Homebrew, nvm, mise,
 * plus toolchain, proxy and API-key variables), so tools Loxel spawns would not see them.
 */
export class LoginShellEnv {
  /** Variables whose value differs from the environment the capture shell started with. */
  private changes: Record<string, string> | null = null;
  private inFlight: Promise<void> | null = null;
  private started = false;
  private lastStartAt = 0;
  private readonly listeners = new Set<LoginShellEnvListener>();

  constructor(private readonly options: LoginShellEnvOptions = {}) {}

  /** The captured changes, or null before the first successful capture. */
  get captured(): Readonly<Record<string, string>> | null {
    return this.changes;
  }

  /**
   * Call `listener` after each capture that changed {@link captured} (the first successful one
   * included). Some startup files export a value that differs on every run (starship's session
   * key, ssh-agent's socket), so check the names the cache depends on. Returns a function that
   * unsubscribes.
   */
  onChange(listener: LoginShellEnvListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Capture now (sharing a capture already running). Never rejects. */
  resolve(): Promise<void> {
    this.started = true;
    return this.inFlight ?? this.capture();
  }

  /**
   * Re-capture, unless {@link resolve} was never called (tests, tools without a server) or a
   * capture started within `minRefreshIntervalMs`; shares a capture already running. Call when a
   * lookup on the spawn PATH misses, since the tool may have been installed since. Never rejects.
   */
  refresh(): Promise<void> {
    if (!this.started) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const minInterval = this.options.minRefreshIntervalMs ?? MIN_REFRESH_INTERVAL_MS;
    if (performance.now() - this.lastStartAt < minInterval) return Promise.resolve();
    return this.capture();
  }

  private capture(): Promise<void> {
    this.lastStartAt = performance.now();
    this.inFlight = this.runCapture().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runCapture(): Promise<void> {
    // Windows has no login shell to ask; apps there inherit the user's environment.
    if (process.platform === "win32") return;
    const shell = this.options.shell ?? (process.env.SHELL || "/bin/zsh");
    const timeoutMs = this.options.timeoutMs ?? CAPTURE_TIMEOUT_MS;
    const startEnv = { ...process.env };
    try {
      const result = await captureLoginShellEnv(shell, startEnv, AbortSignal.timeout(timeoutMs));
      if (result.kind === "aborted") {
        log.warn("Login shell timed out; spawned tools keep the inherited environment", {
          shell,
          timeoutMs,
        });
        return;
      }
      if (result.kind === "no-output") {
        log.warn("Could not read the login shell environment", { shell });
        return;
      }
      const changes: Record<string, string> = {};
      for (const [name, value] of Object.entries(result.env)) {
        if (startEnv[name] !== value) changes[name] = value;
      }
      const changedNames = diffNames(this.changes ?? {}, changes);
      this.changes = changes;
      if (changedNames.size > 0) this.notify(changedNames);
      log.info("Resolved login shell environment", {
        shell,
        changedVariables: Object.keys(changes).length,
      });
    } catch (err) {
      log.warn("Failed to resolve login shell environment", { shell, error: err });
    }
  }

  private notify(changedNames: ReadonlySet<string>): void {
    for (const listener of this.listeners) {
      try {
        listener(changedNames);
      } catch (err) {
        log.warn("Login shell environment listener failed", { error: err });
      }
    }
  }
}

function diffNames(before: Record<string, string>, after: Record<string, string>): Set<string> {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of names) if (before[name] === after[name]) names.delete(name);
  return names;
}

export type CaptureResult =
  | { kind: "env"; env: Record<string, string> }
  | { kind: "aborted" }
  | { kind: "no-output" };

/**
 * Run `shell` as an interactive login shell and read its environment. The shell's only job is to
 * run `/bin/sh` with one single-quoted argument, which parses the same way in sh, bash, zsh, fish,
 * nu and PowerShell (`-l` comes first, the only place PowerShell honors it); sh then prints the environment NUL-separated (or just PATH where `env`
 * lacks `-0`) between random sentinels, so greetings and other startup output are skipped. The
 * shell runs in its own process group, which is killed when `signal` aborts (unless it exited
 * already); reading stops at the closing sentinel, so a background job holding stdout open cannot
 * stall it.
 */
export async function captureLoginShellEnv(
  shell: string,
  env: Env,
  signal: AbortSignal,
): Promise<CaptureResult> {
  const sentinel = `__LOXEL_ENV_${randomUUID().replaceAll("-", "")}__`;
  const script = `printf %s ${sentinel}; env -0 2>/dev/null || printf "PATH=%s\\0" "$PATH"; printf %s ${sentinel}`;
  const proc = Bun.spawn([shell, "-l", "-i", "-c", `/bin/sh -c '${script}'`], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });
  const reader = proc.stdout.getReader();
  let aborted = false;
  // Stays armed after the output arrived, for a shell that hangs in its logout files.
  const onAbort = () => {
    aborted = true;
    killProcessGroup(proc.pid);
    reader.cancel().catch(() => {});
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  void proc.exited.finally(() => signal.removeEventListener("abort", onAbort));

  const decoder = new TextDecoder();
  let output = "";
  let block: string | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
    block = between(output, sentinel);
    if (block !== null) break;
  }
  if (block !== null) reader.cancel().catch(() => {});
  if (aborted) return { kind: "aborted" };

  const parsed = block === null ? null : parseEnvBlock(block);
  return parsed?.PATH ? { kind: "env", env: parsed } : { kind: "no-output" };
}

function between(text: string, sentinel: string): string | null {
  const start = text.indexOf(sentinel);
  if (start === -1) return null;
  const end = text.indexOf(sentinel, start + sentinel.length);
  return end === -1 ? null : text.slice(start + sentinel.length, end);
}

/** `NAME=value` entries separated by NUL, minus {@link SESSION_VARS}. */
function parseEnvBlock(block: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of block.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const name = entry.slice(0, eq);
    if (!SESSION_VARS.has(name)) env[name] = entry.slice(eq + 1);
  }
  return env;
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone
  }
}

const loginShellEnv = new LoginShellEnv();

/**
 * Capture the user's login shell environment for spawned tools. Call once at server startup;
 * later captures happen through {@link refreshLoginShellEnv}. Never rejects.
 */
export function resolveLoginShellEnv(): Promise<void> {
  return loginShellEnv.resolve();
}

/** See {@link LoginShellEnv.onChange}: for caches derived from the spawn environment. */
export function onLoginShellEnvChange(listener: LoginShellEnvListener): () => void {
  return loginShellEnv.onChange(listener);
}

/** See {@link LoginShellEnv.refresh}: call when a tool lookup on the spawn PATH misses. */
export function refreshLoginShellEnv(): Promise<void> {
  return loginShellEnv.refresh();
}

/**
 * Build an env object suitable for spawning child processes: the server's environment with
 * everything the login shell set or changed applied, `~/.local/bin` on PATH, and HOME set.
 */
export function buildSpawnEnv(): Env {
  return withSpawnDefaults({ ...process.env, ...loginShellEnv.captured });
}

/**
 * Like {@link buildSpawnEnv}, but taking only PATH from the login shell, for spawning the user's
 * own login shell: it runs their startup files itself, and re-applying their other variables first
 * would make startup steps that stack (`conda activate`) run twice.
 */
export function buildShellSpawnEnv(): Env {
  const env: Env = { ...process.env };
  const path = loginShellEnv.captured?.PATH;
  if (path) env.PATH = path;
  return withSpawnDefaults(env);
}

function withSpawnDefaults(env: Env): Env {
  const localBin = join(homedir(), ".local", "bin");
  if (!env.PATH || !env.PATH.split(delimiter).includes(localBin)) {
    env.PATH = env.PATH ? `${localBin}${delimiter}${env.PATH}` : localBin;
  }
  if (!env.HOME) {
    env.HOME = homedir();
  }
  return env;
}
