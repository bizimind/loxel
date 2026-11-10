import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// Imported once the DOM globals exist: its `screen` binds to the document there is at import.
const { prettyDOM } = await import("@testing-library/dom");

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

// A failing `expect` prints what it received, and Bun's printer walks all of a happy-dom node's
// object graph, its document and window included: megabytes and seconds per node, with the event
// loop blocked meanwhile, so a `waitFor` around such an `expect` takes seconds for each retry.
// Print a node as its markup instead, as Testing Library does.
Object.defineProperty(Node.prototype, Bun.inspect.custom, {
  configurable: true,
  value(this: Node): string {
    const markup =
      (this instanceof Element || this instanceof Document) &&
      prettyDOM(this, undefined, { highlight: false });
    return markup || `${this.nodeName} ${JSON.stringify(this.textContent)}`;
  },
});
