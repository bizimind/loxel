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
