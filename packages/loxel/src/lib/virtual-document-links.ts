import type { IDisposable } from "monaco-editor";
import {
  type MarkdownRenderOptions,
  MarkdownRendererService,
} from "monaco-editor/platform/markdown/browser/markdownRenderer.js";

import { virtualDocumentSchemes } from "./virtual-documents";

function withVirtualDocumentLinks(options: MarkdownRenderOptions = {}): MarkdownRenderOptions {
  const { sanitizerConfig } = options;
  return {
    ...options,
    sanitizerConfig: {
      ...sanitizerConfig,
      allowedLinkSchemes: {
        augment: [
          ...(sanitizerConfig?.allowedLinkSchemes?.augment ?? []),
          ...virtualDocumentSchemes(),
        ],
      },
    },
  };
}

/**
 * Keeps the links of language servers' virtual documents in rendered markdown (hovers,
 * documentation). Monaco's sanitizer removes the link of any scheme not on its list, and hovers offer
 * no way to add one, so this wraps the renderer service they share. On its prototype, since the
 * service is created late, behind a proxy that keeps the method it finds first. Clicks reach the
 * editor opener like those of `file:` links.
 *
 * Returns a disposable that restores the service.
 */
export function installVirtualDocumentLinks(): IDisposable {
  const { prototype } = MarkdownRendererService;
  const { render } = prototype;
  prototype.render = function (this: unknown, markdown, options, outElement) {
    return render.call(this, markdown, withVirtualDocumentLinks(options), outElement);
  };
  return {
    dispose: () => {
      prototype.render = render;
    },
  };
}
