/** Whether `value` is a non-array object, so its properties can be read as `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
