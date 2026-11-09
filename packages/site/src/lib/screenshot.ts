import type { ImageMetadata } from "astro";
import type { ComponentProps } from "astro/types";
import { type Picture, getImage } from "astro:assets";

type PictureProps = ComponentProps<typeof Picture>;

// Candidate widths below each screenshot's own; its full width is always added as the largest.
const WIDTHS = [640, 960, 1280, 1600, 1920, 2400, 3200];

interface ScreenshotOptions {
  alt: string;
  /** Must match the width the layout gives the image at each breakpoint. */
  sizes: string;
  /** Only for the image above the fold: loads it eagerly and at high priority. */
  priority?: boolean;
}

/**
 * Props for a `<Picture>` of an app screenshot: AVIF in a responsive srcset, WebP for browsers
 * without it. Also returns the screenshot at full size as WebP, which is the srcset's largest
 * fallback candidate. The full width comes from `getImage()` because reading `src.width` directly
 * makes the build also publish the original PNG.
 */
export async function screenshotPicture(
  src: ImageMetadata,
  { alt, sizes, priority = false }: ScreenshotOptions,
): Promise<{ props: PictureProps; fullSizeSrc: string }> {
  const full = await getImage({ src });
  const fullWidth = full.options.width;
  if (fullWidth === undefined) throw new Error(`getImage() returned no width for ${alt}`);

  return {
    fullSizeSrc: full.src,
    props: {
      src,
      // AVIF is about half the size of WebP; browsers without it take the WebP <img>.
      formats: ["avif"],
      fallbackFormat: "webp",
      // <picture> is inline; `contents` keeps the <img> laid out as if it had no wrapper.
      pictureAttributes: { class: "contents" },
      alt,
      priority,
      widths: [...WIDTHS.filter((width) => width < fullWidth), fullWidth],
      sizes,
    },
  };
}
