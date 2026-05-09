/**
 * Sensitive key patterns to redact from logs.
 * Case-insensitive matching.
 */
const SENSITIVE_PATTERNS = [
  "password",
  "token",
  "secret",
  "auth",
  "credential",
  "bearer",
  "authorization",
  "api_key",
  "apikey",
  "client_secret",
  "private_key",
  "privatekey",
  "access_key",
  "accesskey",
];

/** Maximum string length before truncation */
const MAX_STRING_LENGTH = 10 * 1024; // 10KB

/** Redaction placeholder */
const REDACTED = "[REDACTED]";

/** Truncation marker */
const TRUNCATED_MARKER = "...[TRUNCATED]";

/**
 * Check if a key matches sensitive patterns.
 */
function isSensitiveKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return SENSITIVE_PATTERNS.some((pattern) => lowerKey.includes(pattern));
}

/**
 * Check if a value is binary data that should be skipped.
 */
function isBinaryData(value: unknown): boolean {
  if (value === null || value === undefined) return false;

  // Check for ArrayBuffer
  if (value instanceof ArrayBuffer) return true;

  // Check for all TypedArray variants
  if (ArrayBuffer.isView(value)) return true;

  // Check for Blob (browser environment)
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;

  // Check for Buffer (Node.js/Bun environment)
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return true;

  return false;
}

/**
 * Sanitize a single value for logging.
 * - Redacts sensitive values based on key
 * - Skips binary data
 * - Truncates large strings
 * - Recursively sanitizes objects
 *
 * @param value - The value to sanitize
 * @param key - The key name (used for sensitive key detection)
 * @param depth - Current recursion depth for objects
 * @returns Sanitized value or undefined if should be omitted
 */
export function sanitizeValue(value: unknown, key?: string, depth: number = 0): unknown {
  // Skip binary data entirely
  if (isBinaryData(value)) {
    return "[BINARY DATA]";
  }

  // Redact sensitive keys
  if (key && isSensitiveKey(key)) {
    return REDACTED;
  }

  // Handle null/undefined
  if (value === null || value === undefined) {
    return value;
  }

  // Handle primitives
  if (typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  // Handle strings - truncate if too long
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) {
      return value.slice(0, MAX_STRING_LENGTH) + TRUNCATED_MARKER;
    }
    return value;
  }

  // Handle functions - skip
  if (typeof value === "function") {
    return "[FUNCTION]";
  }

  // Handle symbols - skip
  if (typeof value === "symbol") {
    return "[SYMBOL]";
  }

  // Prevent deep recursion
  if (depth > 5) {
    return "[MAX DEPTH]";
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeValue(item, String(index), depth + 1));
  }

  // Handle Date
  if (value instanceof Date) {
    return value.toISOString();
  }

  // Handle Error - should use serializeError instead, but basic handling here
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  // Handle objects
  if (typeof value === "object") {
    const sanitized: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(value)) {
      const sanitizedValue = sanitizeValue(v, k, depth + 1);
      if (sanitizedValue !== undefined) {
        sanitized[k] = sanitizedValue;
      }
    }

    return sanitized;
  }

  // Unknown type - convert to string
  return String(value);
}

/**
 * Sanitize an entire context object for logging.
 */
export function sanitizeContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!context) return undefined;

  const sanitized = sanitizeValue(context, undefined, 0);
  if (typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>;
  }

  return undefined;
}
