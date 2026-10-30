import picomatch from "picomatch";

/** Only comments and blank lines may come before the directive. */
const TOML_DIRECTIVE_RE = /^(?:[ \t]*(?:#[^\n]*)?\r?\n)*?[ \t]*#:schema[ \t]+(\S+)/;
const XML_SCHEMA_LOCATION_RE = /schemaLocation\s*=\s*["']([^"']+)["']/gi;
const XML_SYSTEM_ID_RE = /\b(?:SYSTEM|PUBLIC\s+["'][^"']*["'])\s+["']([^"']+)["']/g;
const XML_MODEL_RE = /<\?xml-model\b[^>]*\bhref\s*=\s*["']([^"']+)["']/g;
/** Enough for any reference at the top of a file, without scanning a huge one on every edit. */
const MAX_SCANNED_CHARS = 256 * 1024;

export function isRemoteSchemaUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * The locations an XML, XSD or DTD text names, as written. `xsi:schemaLocation` holds namespace and
 * location pairs, of which only the locations count; an include's `schemaLocation` holds one.
 */
export function xmlSchemaLocations(text: string): string[] {
  const attributes = [...text.matchAll(XML_SCHEMA_LOCATION_RE)].flatMap((match) => {
    const tokens = match[1]!.trim().split(/\s+/);
    return tokens.length > 1 ? tokens.filter((_, index) => index % 2 === 1) : tokens;
  });
  return [
    ...attributes,
    ...[...text.matchAll(XML_SYSTEM_ID_RE)].map((match) => match[1]!),
    ...[...text.matchAll(XML_MODEL_RE)].map((match) => match[1]!),
  ];
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
    return match && isRemoteSchemaUrl(match[1]!) ? [match[1]!] : [];
  }
  if (language !== "xml") return [];
  return [...new Set(xmlSchemaLocations(text).filter(isRemoteSchemaUrl))];
}

/** Whether a schema glob applies to a file: anywhere under a directory, as Monaco's `fileMatch`. */
export function schemaGlobMatches(glob: string, filePath: string): boolean {
  const relative = glob.replace(/^\/+/, "");
  if (!relative) return false;
  const pattern = relative.startsWith("**/") ? relative : `**/${relative}`;
  return picomatch.isMatch(filePath, pattern, { dot: true });
}
