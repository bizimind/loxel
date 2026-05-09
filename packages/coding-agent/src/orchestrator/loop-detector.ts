/**
 * Deterministic cycle detection for agent tool call sequences.
 *
 * A loop is detected when the same sequence of tool calls repeats without any
 * novel call breaking the pattern. For example:
 * - [tool1(a), tool2(b), tool1(a), tool2(b)] → LOOP (pattern repeats)
 * - [tool1(a), tool2(b), tool1(c), tool2(b)] → NOT LOOP (tool1(c) is novel)
 */

/** Maximum length of cycle pattern to detect (tools in sequence). */
export const MAX_CYCLE_LENGTH = 20;

/** Minimum repetitions required to confirm a cycle. */
export const MIN_REPETITIONS = 2;

export type ToolCallHash = string;

export interface ToolCallRecord {
  tool: string;
  input: unknown;
  hash: ToolCallHash;
}

export type LoopDetectionResult =
  | { type: "ok" }
  | { type: "cycle_detected"; cycleLength: number; repetitions: number };

export interface LoopDetector {
  /** Full hash sequence for analysis. */
  readonly sequence: readonly ToolCallHash[];

  /**
   * Record a tool call, returning whether a loop was detected.
   */
  record(tool: string, input: unknown): LoopDetectionResult;

  /**
   * Get recent tool calls with details for LLM judgment.
   */
  getRecentCalls(n: number): ToolCallRecord[];

  /**
   * Reset detector state after intervention or confirmed legitimate pattern.
   */
  reset(): void;
}

/**
 * Create a stable hash for a tool call.
 * Sorts object keys to ensure consistent hashing regardless of property order.
 */
function createHash(tool: string, input: unknown): ToolCallHash {
  const sortedInput = sortObjectKeys(input);
  return `${tool}:${JSON.stringify(sortedInput)}`;
}

/**
 * Recursively sort object keys for consistent serialization.
 */
function sortObjectKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }

  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const key of keys) {
    sorted[key] = sortObjectKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Compare two string arrays for equality.
 */
function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Create a new loop detector instance.
 */
export function createLoopDetector(): LoopDetector {
  const sequence: ToolCallHash[] = [];
  const callDetails = new Map<ToolCallHash, { tool: string; input: unknown }>();

  return {
    get sequence() {
      return sequence as readonly ToolCallHash[];
    },

    record(tool: string, input: unknown): LoopDetectionResult {
      const hash = createHash(tool, input);
      sequence.push(hash);
      callDetails.set(hash, { tool, input });

      // Check for repeating patterns of length 1 to MAX_CYCLE_LENGTH
      for (let cycleLen = 1; cycleLen <= MAX_CYCLE_LENGTH; cycleLen++) {
        const minLength = cycleLen * MIN_REPETITIONS;
        if (sequence.length < minLength) {
          continue;
        }

        // Extract last chunk of cycleLen as reference
        const referenceStart = sequence.length - cycleLen;
        const referenceChunk = sequence.slice(referenceStart);

        // Compare against previous chunks
        let allMatch = true;
        for (let rep = 1; rep < MIN_REPETITIONS; rep++) {
          const chunkStart = sequence.length - (rep + 1) * cycleLen;
          if (chunkStart < 0) {
            allMatch = false;
            break;
          }

          const chunk = sequence.slice(chunkStart, chunkStart + cycleLen);
          if (!arraysEqual(chunk, referenceChunk)) {
            allMatch = false;
            break;
          }
        }

        if (allMatch) {
          return { type: "cycle_detected", cycleLength: cycleLen, repetitions: MIN_REPETITIONS };
        }
      }

      return { type: "ok" };
    },

    getRecentCalls(n: number): ToolCallRecord[] {
      const recent = sequence.slice(-n);
      return recent.map((hash) => {
        const details = callDetails.get(hash);
        if (!details) {
          // Should never happen in practice
          return { tool: "unknown", input: null, hash };
        }
        return { tool: details.tool, input: details.input, hash };
      });
    },

    reset(): void {
      sequence.length = 0;
      callDetails.clear();
    },
  };
}
