/**
 * Process template substitution using ${VAR} syntax.
 * Uses the same pattern as computeUniqueEnvs in env.ts.
 *
 * Supports escape syntax: \${VAR} outputs literal ${VAR} without substitution.
 * Double backslash \\${VAR} outputs \<value> (escaped backslash + substitution).
 *
 * @param content - File content with ${VAR} placeholders
 * @param env - Environment variables for substitution
 * @returns Content with placeholders replaced. Unknown variables are preserved as-is.
 */
export function processTemplate(content: string, env: Record<string, string>): string {
  // Match optional backslash(es) followed by ${VAR_NAME} patterns
  // VAR_NAME starts with letter/underscore and contains only uppercase letters, digits, and underscores
  return content.replace(/(\\*)\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, backslashes, varName) => {
    const slashCount = backslashes.length;

    if (slashCount % 2 === 1) {
      // Odd number of backslashes: last one escapes the ${}, output literal ${VAR}
      // e.g., \${VAR} -> ${VAR}, \\\${VAR} -> \${VAR}
      const preservedSlashes = "\\".repeat(Math.floor(slashCount / 2));
      return `${preservedSlashes}\${${varName}}`;
    }

    // Even number of backslashes (including 0): all backslashes are literal, substitute variable
    // e.g., ${VAR} -> value, \\${VAR} -> \value
    const preservedSlashes = "\\".repeat(slashCount / 2);
    const value = env[varName] ?? `\${${varName}}`;
    return `${preservedSlashes}${value}`;
  });
}
