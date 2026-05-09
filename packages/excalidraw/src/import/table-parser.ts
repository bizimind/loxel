/**
 * Parse CSV and markdown table formats into a string[][] grid.
 * Auto-detects format: lines with | separators → markdown, otherwise → CSV.
 */

/** Detect whether input is a markdown table (contains | on multiple lines). */
function isMarkdownTable(input: string): boolean {
  const lines = input.trim().split("\n");
  // Markdown tables have | separators on at least 2 non-separator lines
  let pipeLines = 0;
  for (const line of lines) {
    if (line.includes("|") && !/^[\s|:-]+$/.test(line)) {
      pipeLines++;
      if (pipeLines >= 2) return true;
    }
  }
  return false;
}

/** Parse a markdown table into a string[][] grid. */
function parseMarkdownTable(input: string): string[][] {
  const lines = input.trim().split("\n");
  const rows: string[][] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip separator lines (e.g., |---|---|)
    if (/^[\s|:-]+$/.test(trimmed)) continue;
    // Skip empty lines
    if (!trimmed) continue;

    const cells = trimmed
      .split("|")
      .map((c) => c.trim())
      .filter((_, i, arr) => {
        // Remove empty cells from leading/trailing | characters
        if (i === 0 && arr[0] === "") return false;
        if (i === arr.length - 1 && arr[arr.length - 1] === "") return false;
        return true;
      });

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  return rows;
}

/**
 * Parse CSV text into a string[][] grid. Handles quoted fields with commas.
 *
 * Note: Multiline quoted fields (RFC 4180 section 2.6) are not supported.
 * Fields containing literal newlines will be split across rows. This is
 * acceptable for diagram labels which are short single-line strings.
 */
function parseCsv(input: string): string[][] {
  const lines = input.trim().split("\n");
  const rows: string[][] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    rows.push(parseCsvLine(line));
  }

  return rows;
}

/** Parse a single CSV line, handling quoted fields. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          // Escaped quote
          current += '"';
          i++;
        } else {
          // End of quoted field
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }

  cells.push(current.trim());
  return cells;
}

/** Auto-detect format and parse table input into a string[][] grid. */
export function parseTable(input: string): string[][] {
  const rows = isMarkdownTable(input) ? parseMarkdownTable(input) : parseCsv(input);

  if (rows.length === 0) {
    throw new Error("No table data found in input");
  }
  if (rows.length === 1) {
    throw new Error("Table must have at least a header row and one data row");
  }

  // Normalize column count: pad short rows, warn about inconsistency
  const maxCols = Math.max(...rows.map((r) => r.length));
  for (const row of rows) {
    while (row.length < maxCols) {
      row.push("");
    }
  }

  return rows;
}
