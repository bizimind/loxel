/** The search engine URL for a query typed in the address bar or searched from a selection. */
export function webSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/**
 * The page that text typed in an address bar opens: a web URL as is (or the source view of one,
 * which View Page Source puts in the address bar), a domain-like word over https, anything else a
 * web search.
 */
export function addressBarUrl(text: string): string {
  const trimmed = text.trim();
  if (/^(view-source:)?https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[^\s]+\.[^\s]+/.test(trimmed)) return `https://${trimmed}`;
  return webSearchUrl(trimmed);
}
