/**
 * The terminal host's logger. Every line goes to the host's own log file, and lines at info and
 * above are also forwarded to the connected server, which logs them as its own, so they show in the
 * Logs panel. Forwarding is capped per second, so a flood of log lines cannot crowd terminal output
 * off the socket; what the cap holds back is still in the file. A logger of another category (the
 * perf monitor's) says so on each line it forwards, and may forward from a lower level.
 */
import type { ChildLogger, LogLevel } from "@/api/log-entry-model";
import { LOG_LEVEL_PRIORITY, serializeLogContext } from "@/api/log-entry-model";
import { LogFile } from "@/lib/log-file";

import type { HostLogMessage } from "./protocol";

/** The most log lines forwarded to the server in one second. */
const MAX_FORWARDED_PER_SECOND = 50;
const FORWARD_MIN_LEVEL: LogLevel = "info";
const DEFAULT_CATEGORY = "terminal";

export interface HostLoggerOptions {
  /** The lines' category, `terminal` by default. */
  cat?: string;
  /** The lowest level forwarded to the server, `info` by default. */
  forwardFrom?: LogLevel;
}

export class HostLog {
  private readonly file: LogFile;
  private forward: ((message: HostLogMessage) => void) | null = null;
  private windowStart = 0;
  private forwardedInWindow = 0;
  private held = 0;

  constructor(logPath: string) {
    this.file = new LogFile(logPath);
  }

  get path(): string {
    return this.file.path;
  }

  /** Where to forward lines from now on; null while no server is connected. */
  setForward(forward: ((message: HostLogMessage) => void) | null): void {
    this.forward = forward;
  }

  logger(defaultCtx?: Record<string, unknown>, options: HostLoggerOptions = {}): ChildLogger {
    const merge = (ctx?: Record<string, unknown>) => (defaultCtx ? { ...defaultCtx, ...ctx } : ctx);
    const write = (level: LogLevel) => (msg: string, ctx?: Record<string, unknown>) =>
      this.write(level, msg, merge(ctx), options);
    return {
      debug: write("debug"),
      info: write("info"),
      warn: write("warn"),
      error: write("error"),
      flush: async () => {},
      with: (extra) => this.logger({ ...defaultCtx, ...extra }, options),
    };
  }

  close(): void {
    this.file.close();
  }

  private write(
    level: LogLevel,
    msg: string,
    ctx: Record<string, unknown> | undefined,
    { cat = DEFAULT_CATEGORY, forwardFrom = FORWARD_MIN_LEVEL }: HostLoggerOptions,
  ): void {
    const serialized = ctx && Object.keys(ctx).length > 0 ? serializeLogContext(ctx) : undefined;
    const entry = { ts: new Date().toISOString(), level, cat, msg, ctx: serialized };
    this.file.write(JSON.stringify(entry) + "\n");
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[forwardFrom]) return;
    const message: HostLogMessage = { type: "log", level, msg, ctx: serialized };
    this.forwardCapped(cat === DEFAULT_CATEGORY ? message : { ...message, cat });
  }

  private forwardCapped(message: HostLogMessage): void {
    const forward = this.forward;
    if (!forward) return;
    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.forwardedInWindow = 0;
      if (this.held > 0) {
        forward({
          type: "log",
          level: "warn",
          msg: `${this.held} terminal host log lines were not forwarded; see ${this.path}`,
        });
        this.held = 0;
      }
    }
    if (this.forwardedInWindow >= MAX_FORWARDED_PER_SECOND) {
      this.held++;
      return;
    }
    this.forwardedInWindow++;
    forward(message);
  }
}
