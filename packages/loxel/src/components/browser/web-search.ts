/** The search engine URL for a query typed in the address bar or searched from a selection. */
export function webSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}
