import picomatch from "picomatch";

const TOML_DIRECTIVE_RE = /^\s*#:schema\s+(\S+)/m;
/** `xsi:schemaLocation` holds namespace and location pairs, `noNamespaceSchemaLocation` one URL. */
const XML_ATTRIBUTE_RE = /(?:schemaLocation|noNamespaceSchemaLocation)\s*=\s*["']([^"']+)["']/gi;
const XML_SYSTEM_ID_RE = /\b(?:SYSTEM|PUBLIC\s+["'][^"']*["'])\s+["']([^"']+)["']/g;
const XML_MODEL_RE = /<\?xml-model\b[^>]*\bhref\s*=\s*["']([^"']+)["']/g;
/** Enough for any reference at the top of a file, without scanning a huge one on every edit. */
const MAX_SCANNED_CHARS = 256 * 1024;

function httpUrls(candidates: Iterable<string>): string[] {
  const urls = new Set<string>();
  for (const candidate of candidates) {
    if (/^https?:\/\//i.test(candidate)) urls.add(candidate);
  }
  return [...urls];
}

/**
 * The remote schema URLs a TOML or XML file names. Those servers cannot ask for a schema while they
 * work, so the editor reports what a file names when it opens. Relative and local references need
 * no download and are left to the server.
 */
export function schemaUrlsNamedBy(language: string, content: string): string[] {
  const text = content.slice(0, MAX_SCANNED_CHARS);
  if (language === "toml") {
    const match = TOML_DIRECTIVE_RE.exec(text);
    return match ? httpUrls([match[1]!]) : [];
  }
  if (language !== "xml") return [];
  return httpUrls([
    ...[...text.matchAll(XML_ATTRIBUTE_RE)].flatMap((match) => match[1]!.trim().split(/\s+/)),
    ...[...text.matchAll(XML_SYSTEM_ID_RE)].map((match) => match[1]!),
    ...[...text.matchAll(XML_MODEL_RE)].map((match) => match[1]!),
  ]);
}

/** Whether a schema glob applies to a file: anywhere under a directory, as Monaco's `fileMatch`. */
export function schemaGlobMatches(glob: string, filePath: string): boolean {
  const relative = glob.replace(/^\/+/, "");
  if (!relative) return false;
  const pattern = relative.startsWith("**/") ? relative : `**/${relative}`;
  return picomatch.isMatch(filePath, pattern, { dot: true });
}
