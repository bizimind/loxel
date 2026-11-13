/**
 * What a Claude Code session can run (commands, skills, models), asked of Claude itself: a
 * short-lived `claude -p` in stream-json mode answers the `initialize` control request with the
 * same list its `/` menu shows, without a model turn. Cached per directory for a few minutes.
 */
import { z } from "zod";

import type { AgentCatalog } from "@/api/agent-overlay-model";

const CACHE_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 20_000;

const InitializeResponseSchema = z.object({
  type: z.literal("control_response"),
  response: z.object({
    request_id: z.string(),
    response: z
      .object({
        commands: z
          .array(
            z.object({
              name: z.string(),
              description: z.string().default(""),
              argumentHint: z.string().default(""),
            }),
          )
          .default([]),
        models: z
          .array(
            z.object({
              value: z.string(),
              displayName: z.string().default(""),
              description: z.string().default(""),
              supportedEffortLevels: z.array(z.string()).default([]),
            }),
          )
          .default([]),
        claude_code_version: z.string().optional(),
      })
      .passthrough(),
  }),
});

/** Reads the catalog from one stream-json output line, or null if the line is something else. */
export function catalogFromLine(line: string, requestId: string): AgentCatalog | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = InitializeResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.response.request_id !== requestId) return null;
  const { commands, models, claude_code_version } = parsed.data.response.response;
  return {
    commands: commands.map((command) => ({
      // Skills and commands come without the slash the `/` menu shows.
      name: command.name.startsWith("/") ? command.name : `/${command.name}`,
      description: command.description,
      argumentHint: command.argumentHint,
    })),
    models: models.map((model) => ({
      value: model.value,
      displayName: model.displayName || model.value,
      description: model.description,
      efforts: model.supportedEffortLevels,
    })),
    version: claude_code_version ?? null,
  };
}

export class ClaudeCatalog {
  private readonly cache = new Map<string, { at: number; catalog: Promise<AgentCatalog> }>();

  constructor(
    /** The environment `claude` runs with: the login shell's, as for other user tools. */
    private readonly env: () => Record<string, string | undefined>,
  ) {}

  get(cwd: string): Promise<AgentCatalog> {
    const cached = this.cache.get(cwd);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.catalog;
    const catalog = this.probe(cwd);
    this.cache.set(cwd, { at: Date.now(), catalog });
    catalog.catch(() => this.cache.delete(cwd));
    return catalog;
  }

  private async probe(cwd: string): Promise<AgentCatalog> {
    const env = this.env();
    const claude = Bun.which("claude", { PATH: env.PATH ?? "" });
    if (!claude) throw new Error("claude is not on the login shell's PATH");
    const requestId = `loxel-${crypto.randomUUID()}`;
    const proc = Bun.spawn(
      [
        claude,
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "ignore" },
    );
    const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
    try {
      proc.stdin.write(
        `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })}\n`,
      );
      await proc.stdin.flush();
      const decoder = new TextDecoder();
      let pending = "";
      for await (const chunk of proc.stdout) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const catalog = catalogFromLine(line, requestId);
          if (catalog) return catalog;
        }
      }
      throw new Error("claude exited without listing its commands");
    } finally {
      clearTimeout(timer);
      proc.kill();
    }
  }
}
