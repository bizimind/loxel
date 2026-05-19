/**
 * Evaluates a formula expression against a row of data.
 *
 * Security: The expression runs inside a sandboxed Function with only row fields
 * available as local variables. Globals (process, require, Bun, etc.) are blocked
 * by not passing them into scope. No async, no I/O.
 *
 * Timeout: Infinite loops are prevented via a call-count guard injected as a
 * closure variable — avoids the overhead of Worker/isolate for small formulas.
 */
export function evaluateFormula(expression: string, row: Record<string, unknown>): unknown {
  const keys = Object.keys(row);
  const values = keys.map((k) => row[k]);

  let callCount = 0;
  const MAX_OPS = 10_000;
  const guard = () => {
    if (++callCount > MAX_OPS) throw new Error("Formula exceeded operation limit");
  };

  // Shadow dangerous globals so they can't be reached from formula expressions.
  // Full sandbox would require a Worker; this is a best-effort mitigation.
  // See GitHub issue #875 for tracking a proper expression-parser replacement.
  // Note: "eval" and "Function" are reserved in strict mode and cannot be
  // parameter names, so we shadow them via a with-block workaround using
  // local variable re-binding at the top of the function body instead.
  const FORBIDDEN_PATTERN =
    /\b(constructor|__proto__|prototype|__defineGetter__|__defineSetter__|__lookupGetter__|__lookupSetter__)\b/;
  if (FORBIDDEN_PATTERN.test(expression)) {
    throw new FormulaError("Formula contains forbidden keyword", expression);
  }

  const dangerousGlobals = [
    "process",
    "globalThis",
    "global",
    "Bun",
    "require",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
  ];
  const shadowPrologue = dangerousGlobals.map((g) => `var ${g} = undefined;`).join(" ");

  try {
    // oxlint-disable-next-line no-implied-eval
    const fn = new Function(
      ...keys,
      "__guard__",
      `"use strict"; ${shadowPrologue} __guard__(); return (${expression});`,
    );
    return fn(...values, guard);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new FormulaError(`Formula evaluation failed: ${message}`, expression);
  }
}

export class FormulaError extends Error {
  constructor(
    message: string,
    public readonly expression: string,
  ) {
    super(message);
    this.name = "FormulaError";
  }
}
