import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

Element.prototype.scrollIntoView = function scrollIntoView() {};

// happy-dom's Response, which replaces Bun's, has no `bytes()`; Chromium and Bun do, and shiki's
// inlined Oniguruma WASM is decoded through it.
if (!("bytes" in Response.prototype)) {
  Object.defineProperty(Response.prototype, "bytes", {
    writable: true,
    configurable: true,
    async value(this: Response): Promise<Uint8Array> {
      return new Uint8Array(await this.arrayBuffer());
    },
  });
}

// A failing `expect` that prints what it received (`toBeNull`, `toBeInTheDocument`, ...) would walk
// all of a happy-dom node's object graph, its document and window included: megabytes and seconds
// per node, with the event loop blocked meanwhile, so a `waitFor` around such an `expect` took
// seconds for each retry. Print a node as its markup instead, cut where Testing Library's `prettyDOM`
// cuts by default. Bun's diffs for `toEqual` and its kin ignore this, so compare nodes with `toBe`,
// `toBeNull` or `toHaveLength`.
const MAX_PRINTED_MARKUP = 7000;

function nodeMarkup(node: Node): string {
  if (node instanceof Element) return node.outerHTML;
  if (node.nodeType === Node.DOCUMENT_NODE)
    return (node as Document).documentElement?.outerHTML ?? "";
  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    return Array.from(node.childNodes, nodeMarkup).join("");
  }
  return node.nodeType === Node.TEXT_NODE ? (node.textContent ?? "") : "";
}

Object.defineProperty(Node.prototype, Bun.inspect.custom, {
  configurable: true,
  value(this: Node): string {
    const markup = nodeMarkup(this);
    if (!markup) return `${this.nodeName} ${JSON.stringify(this.textContent)}`;
    return markup.length > MAX_PRINTED_MARKUP
      ? `${markup.slice(0, MAX_PRINTED_MARKUP)}...`
      : markup;
  },
});
