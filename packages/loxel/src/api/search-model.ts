export interface SearchMatch {
  /** Absolute file path */
  filePath: string;
  /** 1-based line number */
  line: number;
  /** 1-based column number */
  column: number;
  /** The matching line text (truncated to ~500 chars by rg) */
  lineText: string;
  /** 0-based char offset in lineText where match begins */
  matchStart: number;
  /** 0-based char offset in lineText where match ends */
  matchEnd: number;
}

export interface SearchResponse {
  matches: SearchMatch[];
  /** True if the result count was capped at maxResults */
  truncated: boolean;
}
