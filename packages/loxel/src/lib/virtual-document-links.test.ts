import { afterAll, describe, expect, mock, test } from "bun:test";

import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import {
  IMarkdownRendererService,
  MarkdownRendererService,
} from "monaco-editor/platform/markdown/browser/markdownRenderer.js";

import { installVirtualDocumentLinks } from "./virtual-document-links";
import { registerVirtualDocumentScheme } from "./virtual-documents";

const { prototype } = MarkdownRendererService;
const original = prototype.render;
const render = mock(original);
prototype.render = render;
registerVirtualDocumentScheme({ scheme: "links-doc" }, "java");
const installed = installVirtualDocumentLinks();
afterAll(() => {
  installed.dispose();
  prototype.render = original;
});

describe("installVirtualDocumentLinks", () => {
  test("adds the schemes to what the sanitizer keeps, for the service hovers get", () => {
    const service = StandaloneServices.get(IMarkdownRendererService);

    service.render(
      { value: "[List](links-doc://contents/List.java)" },
      { sanitizerConfig: { allowedLinkSchemes: { augment: ["already-there"] } } },
    );
    service.render({ value: "[List](links-doc://contents/List.java)" });

    const [first, second] = render.mock.calls.map(([, options]) => options);
    expect(first?.sanitizerConfig?.allowedLinkSchemes?.augment).toEqual(
      expect.arrayContaining(["already-there", "links-doc"]),
    );
    expect(second?.sanitizerConfig?.allowedLinkSchemes?.augment).toContain("links-doc");
  });
});
