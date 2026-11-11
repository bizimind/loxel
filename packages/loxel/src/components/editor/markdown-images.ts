/**
 * Image support for the markdown editor: resolves relative `![]()` sources against the file's
 * directory for display (the markdown keeps the original URL), uploads pasted/dropped images
 * via `POST /api/file-upload`, and flags images that fail to load.
 *
 * Uses the inline `image` node from the commonmark preset (which round-trips alt/title
 * verbatim) rather than Crepe's ImageBlock, whose serializer overwrites alt with an aspect
 * ratio on every save.
 */
import { imageInlineComponent, inlineImageConfig } from "@milkdown/kit/component/image-inline";
import type { Editor } from "@milkdown/kit/core";
import { uploadConfig } from "@milkdown/kit/plugin/upload";
import { imageSchema } from "@milkdown/kit/preset/commonmark";
import type { Node as ProseNode, Schema } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

import * as api from "@/api/client";
import { showToast } from "@/components/ui/toast";
import { frontendLog } from "@/lib/frontend-logger";

const log = frontendLog.child("ui");

/** `scheme:` (http, https, data, blob, file, ...) or protocol-relative `//`. */
const EXTERNAL_URL_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Turn a markdown image `src` into a URL the DOM can load.
 * - Absolute/protocol/data URLs pass through untouched.
 * - Everything else is a file path: relative ones resolve against the markdown file's
 *   directory, then get served through `/api/file-raw?path=<absolute>`. No `wt` hint is sent,
 *   so the server only serves paths it already owns (worktree tree or drafts dir) and never
 *   registers unknown paths as external files.
 */
export function resolveImageSrc(src: string, markdownFilePath: string): string {
  if (!src || EXTERNAL_URL_PATTERN.test(src)) return src;

  const dir = markdownFilePath.substring(0, markdownFilePath.lastIndexOf("/"));
  let absolute: string;
  try {
    // Encode every path segment (directory and src alike) so `#`, `?` and `%` in file or
    // worktree names (which come from branch names) are literal, not URL syntax.
    const base = `file://${encodePathSegments(dir)}/`;
    absolute = decodeURIComponent(
      new URL(encodePathSegments(decodePathSegments(src)), base).pathname,
    );
  } catch {
    return src;
  }

  return `/api/file-raw?${new URLSearchParams({ path: absolute }).toString()}`;
}

function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Decode `%XX` escapes a markdown author may have used; a malformed escape stays literal. */
function decodePathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

/** Build a markdown alt text from the uploaded file name (stem only, no extension). */
export function altFromFileName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  return stem || "image";
}

/**
 * Upload one image for the markdown file at `filePath` and return the relative `src` to
 * insert, or `null` after showing a toast if the upload failed. Never throws, so callers never
 * fall back to a blob:/data: URL.
 */
export async function uploadImageFile(filePath: string, file: File): Promise<string | null> {
  try {
    const { src } = await api.uploadFile({ path: filePath, file, nonce: crypto.randomUUID() });
    return src;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    log.warn("Image upload failed", { error: err instanceof Error ? err : undefined });
    showToast(`Image upload failed: ${message}`);
    return null;
  }
}

/**
 * Uploader for `@milkdown/kit/plugin/upload` (paste/drop). Returns inline `image` nodes for
 * the files that uploaded; failed ones are skipped. Never rejects: the upload plugin only
 * removes its placeholder widget on a resolved promise.
 */
export function createImageUploader(filePath: string) {
  return async (files: FileList, schema: Schema): Promise<ProseNode[]> => {
    const imageType = schema.nodes["image"];
    if (!imageType) return [];
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const nodes: ProseNode[] = [];
    for (const file of images) {
      const src = await uploadImageFile(filePath, file);
      if (!src) continue;
      const node = imageType.createAndFill({ src, alt: altFromFileName(file.name) });
      if (node) nodes.push(node);
    }
    return nodes;
  };
}

const stringOrEmpty = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The commonmark `image` node with a parser that tolerates a missing title or alt. remark gives
 * `![alt](src)` a `title: null`, and the preset's runner passes it through to attributes declared
 * `validate: "string"`, so ProseMirror throws and the image is dropped. An empty title serializes
 * back to no title.
 */
const imageSchemaWithOptionalTitle = imageSchema.extendSchema((prev) => (ctx) => {
  const spec = prev(ctx);
  return {
    ...spec,
    parseMarkdown: {
      ...spec.parseMarkdown,
      runner: (state, node, type) => {
        state.addNode(type, {
          src: stringOrEmpty(node["url"]),
          alt: stringOrEmpty(node["alt"]),
          title: stringOrEmpty(node["title"]),
        });
      },
    },
  };
});

/** Class on a paragraph whose only content is an image; the theme centers it as a block. */
export const IMAGE_PARAGRAPH_CLASS = "image-paragraph";

function imageParagraphDecorations(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = [];
  // Top-level paragraphs only: in a table cell or list item an image keeps the cell's alignment
  // and sits next to its bullet.
  doc.forEach((node, pos) => {
    if (node.type.name !== "paragraph") return;
    if (node.childCount === 1 && node.firstChild?.type.name === "image") {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: IMAGE_PARAGRAPH_CLASS }));
    }
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * Tags paragraphs that hold nothing but an image. CSS can't tell on its own: `:only-child`
 * ignores text nodes, so it would also match an icon in the middle of a sentence.
 */
const imageParagraphPlugin = $prose(() => {
  const key = new PluginKey<DecorationSet>("loxel-image-paragraph");
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => imageParagraphDecorations(state.doc),
      apply: (tr, set) => (tr.docChanged ? imageParagraphDecorations(tr.doc) : set),
    },
    props: { decorations: (state) => key.getState(state) },
  });
});

/**
 * Register image rendering and upload on a Crepe editor. Call before `create()` and after the
 * commonmark preset is registered (Crepe's constructor does that), so the extended image schema
 * replaces the preset's.
 * The inline image node view applies `proxyDomURL` to the DOM only; markdown is untouched.
 */
export function installMarkdownImages(editor: Editor, options: { filePath: string }): void {
  editor.use(imageSchemaWithOptionalTitle).use(imageParagraphPlugin);
  editor.use(imageInlineComponent).config((ctx) => {
    ctx.update(inlineImageConfig.key, (prev) => ({
      ...prev,
      proxyDomURL: (url: string) => resolveImageSrc(url, options.filePath),
      // The empty-image "Upload" button: the default returns a blob: URL, which must never be
      // persisted. An empty string makes the node view keep the input open.
      onUpload: async (file: File) => (await uploadImageFile(options.filePath, file)) ?? "",
    }));
    ctx.update(uploadConfig.key, (prev) => ({
      ...prev,
      uploader: createImageUploader(options.filePath),
    }));
  });
}

/**
 * Mark `<img>` elements that fail to load with a `broken` class on their node-view wrapper
 * (styled in milkdown-theme.css). Returns a cleanup function.
 */
export function observeImageLoadErrors(root: HTMLElement): () => void {
  const onError = (e: Event) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    img.closest(".milkdown-image-inline")?.classList.add("broken");
  };
  const onLoad = (e: Event) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    img.closest(".milkdown-image-inline")?.classList.remove("broken");
  };
  // `error`/`load` do not bubble; capture phase catches them from descendants.
  root.addEventListener("error", onError, true);
  root.addEventListener("load", onLoad, true);
  return () => {
    root.removeEventListener("error", onError, true);
    root.removeEventListener("load", onLoad, true);
  };
}
