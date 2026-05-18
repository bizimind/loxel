import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectContext, EvaluationResult, EvaluationError } from "../types.ts";
import { checkKnownPatterns } from "./patterns.ts";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.ts";
import { evaluateReadRequest } from "./read-patterns.ts";

/**
 * Evaluate a Bash command for safety
 * First checks known patterns (fast), then falls back to haiku evaluation
 */
export function evaluateBashCommand(
  command: string,
  context: ProjectContext,
): Promise<EvaluationResult> {
  // Fast path: check known patterns first
  const knownResult = checkKnownPatterns(command, context);
  if (knownResult) {
    return Promise.resolve(knownResult);
  }

  // Slow path: use haiku for unknown patterns
  return evaluateWithHaiku(command, context);
}

/**
 * Evaluate a Read tool request for safety
 * Checks for sensitive files - all other reads are allowed
 */
export function evaluateReadFile(filePath: string, context: ProjectContext): EvaluationResult {
  return evaluateReadRequest(filePath, context);
}

// Keep the old name as an alias for backward compatibility
export const evaluateCommand = evaluateBashCommand;

const MAX_RETRIES = 2;

/** JSON schema for Haiku response */
const HAIKU_RESPONSE_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    classification: { type: "string", enum: ["safe", "uncertain"] },
    reason: { type: "string" },
    pattern: { type: ["string", "null"] },
  },
  required: ["classification", "reason"],
});

/**
 * Evaluate command using claude -p with haiku model
 * Uses --json-schema for structured output and --system-prompt-file for the prompt
 * Retries up to MAX_RETRIES times if evaluation fails
 */
async function evaluateWithHaiku(
  command: string,
  context: ProjectContext,
): Promise<EvaluationResult> {
  const errors: EvaluationError[] = [];
  const userPrompt = buildUserPrompt(command, context);

  // Write system prompt to temp file to avoid shell escaping issues
  const systemPromptFile = join(tmpdir(), `cc-tool-guard-system-${Date.now()}.txt`);
  const userPromptFile = join(tmpdir(), `cc-tool-guard-user-${Date.now()}.txt`);

  try {
    await writeFile(systemPromptFile, SYSTEM_PROMPT, "utf8");
    await writeFile(userPromptFile, userPrompt, "utf8");

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Use Bun.spawn to avoid shell escaping issues
        const proc = Bun.spawn(
          [
            "claude",
            "-p",
            "--model",
            "haiku",
            "--output-format",
            "json",
            "--json-schema",
            HAIKU_RESPONSE_SCHEMA,
            "--tools",
            "",
            "--system-prompt-file",
            systemPromptFile,
            "--max-turns",
            "2",
            "--no-session-persistence",
            "--setting-sources",
            "",
            "--agents",
            "{}",
          ],
          { stdin: Bun.file(userPromptFile), stdout: "pipe", stderr: "pipe" },
        );

        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();

        if (exitCode !== 0) {
          const errorMsg = `Exit code ${exitCode}: ${stderr.trim()}`;
          console.error(`[cc-tool-guard] Haiku evaluation failed: ${errorMsg}`);
          errors.push({ stage: "haiku-call", message: errorMsg, attempt });
          continue; // Retry
        }

        const parsed = parseHaikuResponse(stdout.trim(), errors, attempt);

        if (parsed) {
          return {
            ...parsed,
            evaluationPath: "haiku",
            errors: errors.length > 0 ? errors : undefined,
          };
        }

        // Parsing failed, retry if attempts remaining
        if (attempt < MAX_RETRIES) {
          console.error(`[cc-tool-guard] Parse failed, retrying (${attempt + 1}/${MAX_RETRIES})`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[cc-tool-guard] Error calling claude: ${errorMsg}`);
        errors.push({ stage: "haiku-call", message: errorMsg, attempt });
      }
    }

    // All retries exhausted
    return {
      classification: "uncertain",
      reason: "Evaluation failed after retries, defaulting to manual review",
      evaluationPath: "haiku-failed",
      errors,
    };
  } finally {
    // Clean up temp files
    try {
      await unlink(systemPromptFile);
      await unlink(userPromptFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Parse the JSON response from haiku
 * With --output-format json, response is JSON with structured_output field
 * Returns null if parsing fails (triggers retry)
 */
function parseHaikuResponse(
  output: string,
  errors: EvaluationError[],
  attempt: number,
): Omit<EvaluationResult, "evaluationPath" | "errors"> | null {
  try {
    const response = JSON.parse(output);

    // With --output-format json, the structured output is in structured_output field
    const parsed = response.structured_output ?? response;

    // Validate classification (schema should enforce this, but double-check)
    if (parsed.classification !== "safe" && parsed.classification !== "uncertain") {
      const errorMsg = `Invalid classification: ${parsed.classification}`;
      console.error(`[cc-tool-guard] ${errorMsg}`);
      errors.push({ stage: "haiku-validation", message: errorMsg, attempt });
      return null;
    }

    // Normalize pattern if provided
    let pattern = parsed.pattern;
    if (pattern && pattern !== "null") {
      pattern = normalizePattern(pattern);
    } else {
      pattern = undefined;
    }

    return {
      classification: parsed.classification,
      reason: parsed.reason || "No reason provided",
      suggestedPattern: pattern,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[cc-tool-guard] JSON parse error: ${errorMsg}`);
    errors.push({ stage: "haiku-parse", message: errorMsg, attempt });
    return null;
  }
}

/**
 * Normalize pattern to ensure :* suffix
 */
function normalizePattern(pattern: string): string {
  if (pattern.endsWith(":*")) return pattern;
  if (pattern.endsWith("*")) return pattern.slice(0, -1) + ":*";
  return pattern + ":*";
}
