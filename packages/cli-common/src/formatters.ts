/**
 * Formatting helpers for human-readable CLI output.
 * These can be combined to build complex output formats.
 */

/**
 * Format key-value pairs as aligned output.
 *
 * @example
 * formatKeyValue({ version: "1.0.0", platform: "darwin-arm64" })
 * // "Version:  1.0.0\nPlatform: darwin-arm64"
 */
export function formatKeyValue(
  data: Record<string, string | number | boolean | undefined | null>,
  options?: {
    /** Key label transformer (default: capitalize first letter) */
    labelTransform?: (key: string) => string;
    /** Separator between label and value (default: ": ") */
    separator?: string;
    /** Filter out undefined/null values (default: true) */
    filterEmpty?: boolean;
  },
): string {
  const { labelTransform = capitalize, separator = ": ", filterEmpty = true } = options ?? {};

  const entries = Object.entries(data).filter(
    ([, v]) => !filterEmpty || (v !== undefined && v !== null),
  );

  if (entries.length === 0) return "";

  // Calculate max label width for alignment
  const maxLabelWidth = Math.max(...entries.map(([k]) => labelTransform(k).length));

  return entries
    .map(([key, value]) => {
      const label = labelTransform(key).padEnd(maxLabelWidth);
      return `${label}${separator}${value}`;
    })
    .join("\n");
}

/**
 * Format data as a table with headers.
 *
 * @example
 * formatTable(
 *   [{ name: "foo", branch: "main" }, { name: "bar", branch: "dev" }],
 *   [
 *     { key: "name", label: "Name" },
 *     { key: "branch", label: "Branch" },
 *   ]
 * )
 */
export function formatTable<T extends Record<string, unknown>>(
  rows: T[],
  columns: Array<{
    /** Key to extract from each row */
    key: keyof T;
    /** Column header label */
    label: string;
    /** Custom value formatter */
    format?: (value: T[keyof T], row: T) => string;
    /** Alignment (default: "left") */
    align?: "left" | "right";
  }>,
  options?: {
    /** No data message */
    emptyMessage?: string;
    /** Show header row (default: true) */
    showHeader?: boolean;
    /** Column separator (default: "  ") */
    columnSeparator?: string;
    /** Header separator character (default: "-") */
    headerSeparator?: string;
  },
): string {
  const {
    emptyMessage = "No data",
    showHeader = true,
    columnSeparator = "  ",
    headerSeparator = "-",
  } = options ?? {};

  if (rows.length === 0) return emptyMessage;

  // Calculate column widths
  const widths = columns.map((col) => {
    const headerWidth = col.label.length;
    const maxDataWidth = Math.max(
      ...rows.map((row) => {
        const value = col.format ? col.format(row[col.key], row) : String(row[col.key] ?? "");
        return value.length;
      }),
    );
    return Math.max(headerWidth, maxDataWidth);
  });

  const formatRow = (values: string[]): string => {
    return values
      .map((val, i) => {
        const col = columns[i];
        const width = widths[i] ?? 0;
        return col?.align === "right" ? val.padStart(width) : val.padEnd(width);
      })
      .join(columnSeparator);
  };

  const lines: string[] = [];

  if (showHeader) {
    lines.push(formatRow(columns.map((c) => c.label)));
    lines.push(widths.map((w) => headerSeparator.repeat(w)).join(columnSeparator));
  }

  for (const row of rows) {
    const values = columns.map((col) => {
      if (col.format) return col.format(row[col.key], row);
      return String(row[col.key] ?? "");
    });
    lines.push(formatRow(values));
  }

  return lines.join("\n");
}

/**
 * Format a list of items with optional bullet points.
 *
 * @example
 * formatList(["item1", "item2"], { bullet: "- " })
 * // "- item1\n- item2"
 */
export function formatList(
  items: string[],
  options?: {
    /** Bullet/prefix for each item (default: "") */
    bullet?: string;
    /** Indent for each item (default: "") */
    indent?: string;
    /** Empty list message */
    emptyMessage?: string;
  },
): string {
  const { bullet = "", indent = "", emptyMessage = "" } = options ?? {};

  if (items.length === 0) return emptyMessage;

  return items.map((item) => `${indent}${bullet}${item}`).join("\n");
}

/**
 * Format a section with a header.
 *
 * @example
 * formatSection("Details", "Some content here")
 * // "Details:\n  Some content here"
 */
export function formatSection(
  header: string,
  content: string,
  options?: {
    /** Indent for content (default: "  ") */
    indent?: string;
    /** Header suffix (default: ":") */
    headerSuffix?: string;
  },
): string {
  const { indent = "  ", headerSuffix = ":" } = options ?? {};

  const indentedContent = content
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");

  return `${header}${headerSuffix}\n${indentedContent}`;
}

/**
 * Combine multiple formatted sections with blank line separators.
 */
export function formatSections(...sections: (string | undefined | null | false)[]): string {
  return sections.filter((s): s is string => !!s).join("\n\n");
}

/**
 * Capitalize first letter of a string.
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Format a status indicator with checkmark or X.
 *
 * @example
 * formatStatus(true, "Connected")
 * // "✓ Connected"
 * formatStatus(false, "Disconnected")
 * // "✗ Disconnected"
 */
export function formatStatus(ok: boolean, message: string): string {
  return ok ? `✓ ${message}` : `✗ ${message}`;
}

/**
 * Format a duration in milliseconds to human-readable format.
 * Uses the two most significant units (e.g., "1d 2h", "3h 45m", "2m 30s").
 *
 * @example
 * formatDuration(90000)     // "1m 30s"
 * formatDuration(3661000)   // "1h 1m"
 * formatDuration(86400000)  // "1d 0h"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return "0s";

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}
