/**
 * Loop control orchestration combining deterministic cycle detection with LLM judgment.
 */

import type { LanguageModel } from "ai";

import {
  createLoopDetector,
  type LoopDetector,
  type LoopDetectionResult,
} from "./loop-detector.ts";
import { judgeProgress, type LoopJudgment, type ToolCallSummary } from "./loop-judge.ts";

/** Maximum tool call history to retain (prevents unbounded memory growth). */
const MAX_HISTORY_SIZE = 200;

/**
 * Configuration for loop control behavior.
 */
export interface LoopControlConfig {
  /** Check progress every N tool calls. */
  periodicCheckInterval: number;
  /** Absolute maximum tool calls before forcing stop. */
  maxSafetySteps: number;
}

export const DEFAULT_LOOP_CONTROL_CONFIG: LoopControlConfig = {
  periodicCheckInterval: 50,
  maxSafetySteps: 500,
};

/**
 * Action to take based on loop control analysis.
 */
export type LoopControlAction =
  | { action: "continue" }
  | { action: "break"; reason: string; message: string }
  | { action: "inject_reminder"; reason: string; message: string };

/**
 * Controller orchestrating cycle detection and LLM judgment.
 */
export class LoopController {
  private readonly detector: LoopDetector;
  private toolCallCount = 0;
  private toolCallHistory: ToolCallSummary[] = [];

  constructor(
    private readonly config: LoopControlConfig = DEFAULT_LOOP_CONTROL_CONFIG,
    private readonly judgeModel: LanguageModel | null,
    private readonly task: string,
  ) {
    this.detector = createLoopDetector();
  }

  /**
   * Get current tool call count.
   */
  getToolCallCount(): number {
    return this.toolCallCount;
  }

  /**
   * Get recent tool call history.
   */
  getToolCallHistory(): readonly ToolCallSummary[] {
    return this.toolCallHistory;
  }

  /**
   * Get the number of entries in the cycle detector's hash sequence.
   */
  getDetectorSequenceLength(): number {
    return this.detector.sequence.length;
  }

  /**
   * Process a completed tool call and determine if loop control action is needed.
   *
   * @param tool - Tool name
   * @param input - Tool input arguments
   * @param output - Tool output/result
   * @returns Action to take (continue, break, or inject reminder)
   */
  async onToolCall(tool: string, input: unknown, output: unknown): Promise<LoopControlAction> {
    this.toolCallCount++;
    this.toolCallHistory.push({ tool, input, output, timestamp: Date.now() });

    // Trim history to prevent unbounded memory growth
    if (this.toolCallHistory.length > MAX_HISTORY_SIZE) {
      this.toolCallHistory = this.toolCallHistory.slice(-MAX_HISTORY_SIZE);
    }

    // 1. Deterministic cycle detection
    const detection = this.detector.record(tool, input);
    if (detection.type === "cycle_detected") {
      const judgment = await this.judgeCycleSafe(detection);
      if (judgment.verdict === "stuck") {
        return {
          action: "break",
          reason: "cycle_detected",
          message: judgment.suggestion ?? "Detected repeating pattern without progress",
        };
      }
      // If productive or uncertain, continue but reset detector to avoid repeated triggers
      this.detector.reset();
    }

    // 2. Periodic progress check
    if (this.toolCallCount % this.config.periodicCheckInterval === 0 && this.toolCallCount > 0) {
      const judgment = await this.judgePeriodicProgressSafe();
      if (judgment.verdict === "stuck") {
        return {
          action: "inject_reminder",
          reason: "periodic_check_failed",
          message: judgment.suggestion ?? "You seem to be stuck. Try a different approach.",
        };
      }
    }

    // 3. Safety limit
    if (this.toolCallCount >= this.config.maxSafetySteps) {
      return {
        action: "break",
        reason: "safety_limit",
        message: `Reached maximum ${this.config.maxSafetySteps} tool calls`,
      };
    }

    return { action: "continue" };
  }

  /**
   * Judge a detected cycle pattern with error handling.
   * Falls back to assuming stuck if LLM call fails.
   */
  private async judgeCycleSafe(
    detection: LoopDetectionResult & { type: "cycle_detected" },
  ): Promise<LoopJudgment> {
    // If no judge model, assume stuck when cycle detected
    if (!this.judgeModel) {
      return {
        verdict: "stuck",
        reasoning: "Cycle detected and no judge model available for verification",
        suggestion: "Detected repeating tool call pattern. Please try a different approach.",
      };
    }

    try {
      const pattern = this.detector.getRecentCalls(detection.cycleLength);
      return await judgeProgress(
        {
          task: this.task,
          toolCalls: this.toolCallHistory.slice(-50),
          cycleInfo: { cycleLength: detection.cycleLength, pattern: pattern.map((p) => p.tool) },
        },
        this.judgeModel,
      );
    } catch {
      // If LLM judgment fails, assume stuck since we detected a cycle
      return {
        verdict: "stuck",
        reasoning: "Cycle detected and LLM judgment failed",
        suggestion: "Detected repeating tool call pattern. Please try a different approach.",
      };
    }
  }

  /**
   * Judge periodic progress with error handling.
   * Falls back to productive if LLM call fails.
   */
  private async judgePeriodicProgressSafe(): Promise<LoopJudgment> {
    // If no judge model, always continue (rely only on deterministic detection)
    if (!this.judgeModel) {
      return { verdict: "productive", reasoning: "No judge model available, assuming productive" };
    }

    try {
      return await judgeProgress(
        { task: this.task, toolCalls: this.toolCallHistory.slice(-50) },
        this.judgeModel,
      );
    } catch {
      // If LLM judgment fails during periodic check, assume productive to avoid false breaks
      return {
        verdict: "productive",
        reasoning: "LLM judgment failed, assuming productive to avoid false breaks",
      };
    }
  }

  /**
   * Reset controller state.
   */
  reset(): void {
    this.toolCallCount = 0;
    this.toolCallHistory = [];
    this.detector.reset();
  }
}
