import type { IDisposable } from "monaco-editor";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { IMarkdownRendererService } from "monaco-editor/platform/markdown/browser/markdownRenderer.js";

import { virtualDocumentSchemes } from "./virtual-documents";

/**
 * Keeps the links of language servers' virtual documents in rendered markdown (hovers,
 * documentation). Monaco's sanitizer removes the link of any scheme not on its list, and hovers offer
 * no way to add one, so this wraps the renderer service they share. Clicks reach the editor opener
 * like those of `file:` links.
 *
 * Returns a disposable that restores the service.
 */
export function installVirtualDocumentLinks(): IDisposable {
  const service = StandaloneServices.get(IMarkdownRendererService);
  const render = service.render.bind(service);
  service.render = (markdown, options, outElement) =>
    render(
      markdown,
      {
        ...options,
        sanitizerConfig: {
          ...options?.sanitizerConfig,
          allowedLinkSchemes: {
            augment: [
              ...(options?.sanitizerConfig?.allowedLinkSchemes?.augment ?? []),
              ...virtualDocumentSchemes(),
            ],
          },
        },
      },
      outElement,
    );
  return {
    dispose: () => {
      service.render = render;
    },
  };
}
