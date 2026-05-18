import type { SerializedError } from "../types.ts";
import { sanitizeValue } from "./sanitizer.ts";

/** Maximum depth for cause chain traversal to prevent infinite loops */
const MAX_CAUSE_DEPTH = 10;

/** Properties to exclude from enumerable props extraction */
const EXCLUDED_PROPS = new Set(["stack", "message", "name", "cause"]);

/**
 * Extract enumerable properties from an error object.
 * Excludes standard Error properties (stack, message, name, cause).
 */
function extractEnumerableProps(error: Error): Record<string, unknown> | undefined {
  const props: Record<string, unknown> = {};

  for (const key of Object.keys(error)) {
    if (EXCLUDED_PROPS.has(key)) continue;

    const value = (error as unknown as Record<string, unknown>)[key];
    const sanitized = sanitizeValue(value, key);
    if (sanitized !== undefined) {
      props[key] = sanitized;
    }
  }

  return Object.keys(props).length > 0 ? props : undefined;
}

/**
 * Serialize an error and its cause chain into a structured format.
 * Recursively processes the cause chain up to MAX_CAUSE_DEPTH.
 *
 * @param error - The error to serialize
 * @param depth - Current recursion depth (internal use)
 * @returns Serialized error structure or undefined if error is falsy
 */
export function serializeError(error: unknown, depth: number = 0): SerializedError | undefined {
  if (!error) return undefined;

  // Prevent infinite recursion
  if (depth >= MAX_CAUSE_DEPTH) {
    return { name: "MaxDepthExceeded", message: `Cause chain exceeded ${MAX_CAUSE_DEPTH} levels` };
  }

  // Handle Error instances
  if (error instanceof Error) {
    const serialized: SerializedError = { name: error.name, message: error.message };

    // Extract additional enumerable properties
    const props = extractEnumerableProps(error);
    if (props) {
      serialized.props = props;
    }

    // Recursively serialize cause chain
    if (error.cause) {
      serialized.cause = serializeError(error.cause, depth + 1);
    }

    return serialized;
  }

  // Handle non-Error values thrown
  if (typeof error === "string") {
    return { name: "StringError", message: error };
  }

  if (typeof error === "object") {
    // Try to extract message from object
    const obj = error as Record<string, unknown>;
    return {
      name: String(obj.name ?? "UnknownError"),
      message: String(obj.message ?? JSON.stringify(error)),
    };
  }

  // Fallback for other types
  return { name: "UnknownError", message: String(error) };
}
