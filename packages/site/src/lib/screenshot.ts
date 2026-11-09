import type { ImageMetadata } from "astro";
import type { ComponentProps } from "astro/types";
import { type Picture, getImage } from "astro:assets";

type PictureProps = ComponentProps<typeof Picture>;

// Candidate widths, up to 3200: the full 4064px capture (its shadow margin included) would only
// serve the hero above a 2560px screen at 2x, and is by far the slowest to encode.
const MAX_WIDTH = 3200;
const WIDTHS = [640, 960, 1280, 1600, 1920, 2400, MAX_WIDTH];

interface ScreenshotOptions {
  alt: string;
  /** Must match the width the layout gives the image at each breakpoint. */
  sizes: string;
  /** Only for the image above the fold: loads it eagerly and at high priority. */
  priority?: boolean;
}

/**
 * Props for a `<Picture>` of an app screenshot: AVIF in a responsive srcset, WebP for browsers
 * without it (Astro leaves out widths above the screenshot's own). Also returns the 1920px WebP,
 * one of the srcset's own files, for a link to the image such as structured data.
 */
export async function screenshotPicture(
  src: ImageMetadata,
  { alt, sizes, priority = false }: ScreenshotOptions,
): Promise<{ props: PictureProps; linkSrc: string }> {
  const link = await getImage({ src, width: 1920, format: "webp" });
  return {
    linkSrc: link.src,
    props: {
      src,
      // AVIF is about half the size of WebP; browsers without it take the WebP <img>.
      formats: ["avif"],
      fallbackFormat: "webp",
      // <picture> is inline; `contents` keeps the <img> laid out as if it had no wrapper.
      pictureAttributes: { class: "contents" },
      alt,
      priority,
      widths: WIDTHS,
      // The fallback `src` (and the `width`/`height` attributes, which keep the aspect ratio) default
      // to the capture's own 4064px: a file no browser picks from the srcset. The largest candidate
      // makes `src` one of the srcset's own files instead.
      width: MAX_WIDTH,
      sizes,
    },
  };
}
