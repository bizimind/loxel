/**
 * XML text without its comments, scanned with `indexOf` rather than a lazy regular expression, which
 * takes quadratic time over an unclosed comment in a repository's file on the server's only thread.
 * `unclosed` says whether the last comment ran to the end, which is all the text after it.
 */
export function scanXmlComments(xml: string): { text: string; unclosed: boolean } {
  let text = "";
  let from = 0;
  for (let open = xml.indexOf("<!--"); open !== -1; open = xml.indexOf("<!--", from)) {
    text += xml.slice(from, open);
    const close = xml.indexOf("-->", open + 4);
    if (close === -1) return { text, unclosed: true };
    from = close + 3;
  }
  return { text: text + xml.slice(from), unclosed: false };
}

export function withoutXmlComments(xml: string): string {
  return scanXmlComments(xml).text;
}
