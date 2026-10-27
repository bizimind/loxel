/**
 * The `file://` URI of an absolute path, percent-encoded exactly as Monaco's `Uri.toString()`
 * writes it (everything but unreserved characters and `/`), so the URIs the server sends match the
 * client's document URIs as strings too. `pathToFileURL` leaves `+ ( ) @ ' ; = !` and others alone.
 */
export function fileUri(absPath: string): string {
  const encoded = absPath
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
  return `file://${encoded}`;
}
