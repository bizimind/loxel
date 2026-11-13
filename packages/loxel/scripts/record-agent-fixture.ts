/**
 * Records a short real Claude Code session through the Agent SDK as an NDJSON replay fixture for
 * the agent translator tests: one AskUserQuestion, one Bash permission request, one reply. Paths
 * and ids are replaced with stable placeholders. Uses Haiku in a scratch directory; costs a few
 * cents. Run: bun scripts/record-agent-fixture.ts <scratch-dir> <out.ndjson>
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { findClaudeExecutable } from "@/server/agent/claude-sdk-transport";

const [scratch, out] = process.argv.slice(2);
if (!scratch || !out) throw new Error("usage: record-agent-fixture.ts <scratch-dir> <out.ndjson>");
const cwd = realpathSync(scratch);

const prompts = [
  "Use the AskUserQuestion tool to ask me which color I prefer, with the options red and blue. Then reply with only the color I chose.",
  "Run the shell command `echo fixture-ok` with the Bash tool, then reply with only its output.",
];

const lines: string[] = [];
let resolveTurn: (() => void) | null = null;

async function* input(): AsyncIterable<SDKUserMessage> {
  for (const text of prompts) {
    yield {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    };
    await new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
  }
}

const executable = await findClaudeExecutable();
if (!executable) throw new Error("no claude on PATH");

const q = query({
  prompt: input(),
  options: {
    cwd,
    model: "haiku",
    pathToClaudeCodeExecutable: executable,
    systemPrompt: { type: "preset", preset: "claude_code" },
    includePartialMessages: true,
    extraArgs: { "replay-user-messages": null },
    canUseTool: async (toolName, toolInput, options) => {
      lines.push(
        JSON.stringify({
          kind: "can_use_tool",
          toolName,
          input: toolInput,
          suggestions: options.suggestions ?? [],
        }),
      );
      if (toolName === "AskUserQuestion") {
        const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
        const first = questions[0] as { question?: string } | undefined;
        return {
          behavior: "allow",
          updatedInput: { ...toolInput, answers: { [first?.question ?? ""]: "blue" } },
        };
      }
      return { behavior: "allow", updatedInput: toolInput };
    },
  },
});

for await (const message of q) {
  lines.push(JSON.stringify({ kind: "message", message }));
  if (message.type === "result") {
    const next = resolveTurn as (() => void) | null;
    resolveTurn = null;
    if (next) next();
    if (lines.filter((l) => l.includes('"type":"result"')).length >= prompts.length) break;
  }
}
q.close();

/** Keep only the init fields the translator reads: the rest lists the recording user's setup. */
function trimInit(line: string): string {
  const entry = JSON.parse(line) as { kind: string; message?: Record<string, unknown> };
  const message = entry.message;
  if (message?.type !== "system" || message.subtype !== "init") return line;
  const keep = [
    "type",
    "subtype",
    "session_id",
    "uuid",
    "model",
    "permissionMode",
    "claude_code_version",
    "cwd",
  ];
  entry.message = Object.fromEntries(keep.filter((k) => k in message).map((k) => [k, message[k]]));
  return JSON.stringify(entry);
}

const sanitized = lines
  .map(trimInit)
  .join("\n")
  .replaceAll(cwd, "/work/fixture")
  .replaceAll(homedir(), "/home/user")
  .replaceAll(/-private-tmp-[^/"]*|-Users-[^/"]*/g, "-work-fixture");
await Bun.write(out, sanitized + "\n");
console.log(`wrote ${lines.length} lines to ${out}`);
