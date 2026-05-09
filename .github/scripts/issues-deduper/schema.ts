/**
 * Schema definitions for the issue deduplication output.
 */

export type RelationshipType =
  | "duplicate" // Essentially the same issue (close one)
  | "subset" // This issue is fully covered by the related issue (close this)
  | "superset" // This issue fully covers the related issue (related should close)
  | "overlapping" // Significant shared scope but each has unique value
  | "related"; // Same domain/feature area but distinct scope

export type ConfidenceLevel = "high" | "medium" | "low";

export interface Relation {
  /** The related issue number */
  related_issue: number;
  /** Type of relationship between the issues */
  relationship: RelationshipType;
  /** Confidence level of this assessment */
  confidence: ConfidenceLevel;
  /** Brief explanation for audit trail */
  reasoning: string;
  /** If closing, what unique info to preserve as a comment */
  unique_value?: string;
}

export interface DedupeResult {
  /** The issue number being checked */
  issue_number: number;
  /** List of related issues found */
  relations: Relation[];
}

/**
 * JSON Schema for Claude Code's --json-schema parameter.
 * This enforces structured output from the agent.
 */
export const DEDUPE_RESULT_SCHEMA = {
  type: "object",
  properties: {
    issue_number: { type: "integer", description: "The issue number being checked" },
    relations: {
      type: "array",
      description: "List of related issues found",
      items: {
        type: "object",
        properties: {
          related_issue: { type: "integer", description: "The related issue number" },
          relationship: {
            type: "string",
            enum: ["duplicate", "subset", "superset", "overlapping", "related"],
            description: "Type of relationship between the issues",
          },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "Confidence level of this assessment",
          },
          reasoning: { type: "string", description: "Brief explanation for audit trail" },
          unique_value: {
            type: "string",
            description: "If closing, what unique info to preserve as a comment",
          },
        },
        required: ["related_issue", "relationship", "confidence", "reasoning"],
        additionalProperties: false,
      },
    },
  },
  required: ["issue_number", "relations"],
  additionalProperties: false,
};

/**
 * Validates a DedupeResult object.
 * Returns true if valid, throws if invalid.
 */
export function validateDedupeResult(obj: unknown): obj is DedupeResult {
  if (typeof obj !== "object" || obj === null) {
    throw new Error("Result must be an object");
  }

  const result = obj as Record<string, unknown>;

  if (typeof result.issue_number !== "number") {
    throw new Error("issue_number must be a number");
  }

  if (!Array.isArray(result.relations)) {
    throw new Error("relations must be an array");
  }

  const validRelationships = ["duplicate", "subset", "superset", "overlapping", "related"];
  const validConfidences = ["high", "medium", "low"];

  for (const rel of result.relations) {
    if (typeof rel !== "object" || rel === null) {
      throw new Error("Each relation must be an object");
    }

    const relation = rel as Record<string, unknown>;

    if (typeof relation.related_issue !== "number") {
      throw new Error("related_issue must be a number");
    }

    if (!validRelationships.includes(relation.relationship as string)) {
      throw new Error(
        `Invalid relationship: ${relation.relationship}. Must be one of: ${validRelationships.join(", ")}`,
      );
    }

    if (!validConfidences.includes(relation.confidence as string)) {
      throw new Error(
        `Invalid confidence: ${relation.confidence}. Must be one of: ${validConfidences.join(", ")}`,
      );
    }

    if (typeof relation.reasoning !== "string") {
      throw new Error("reasoning must be a string");
    }

    if (relation.unique_value !== undefined && typeof relation.unique_value !== "string") {
      throw new Error("unique_value must be a string if provided");
    }
  }

  return true;
}
