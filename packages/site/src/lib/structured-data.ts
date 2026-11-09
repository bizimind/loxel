// schema.org JSON-LD nodes, rendered by Base.astro as one `@graph`. Nodes reference each other by `@id`.
import type { ManifestData } from "./manifest";
import { GITHUB_ORG_URL, GITHUB_REPO_URL, ORG_NAME, SITE_DESCRIPTION, SITE_NAME } from "./site";

export type StructuredDataNode = Record<string, unknown> & { "@type": string };

// With the trailing slash, matching the home page canonical URL.
const SITE_URL = new URL("/", import.meta.env.SITE).href;
const ORG_ID = `${SITE_URL}#organization`;
const WEBSITE_ID = `${SITE_URL}#website`;
const APP_ID = `${SITE_URL}#software`;

/** The publisher and the site itself, included on every page. */
export function siteNodes(): StructuredDataNode[] {
  return [
    {
      "@type": "Organization",
      "@id": ORG_ID,
      name: ORG_NAME,
      url: SITE_URL,
      // Raster, opaque, and at least 112px: logo.svg is white on transparent, blank on a white page.
      logo: new URL("/apple-touch-icon.png", SITE_URL).href,
      sameAs: [GITHUB_ORG_URL],
    },
    {
      "@type": "WebSite",
      "@id": WEBSITE_ID,
      name: SITE_NAME,
      url: SITE_URL,
      inLanguage: "en",
      publisher: { "@id": ORG_ID },
    },
  ];
}

/** Loxel the app, and the GitHub repository it is built from. */
export function softwareNodes(manifest: ManifestData, screenshotUrl: string): StructuredDataNode[] {
  return [
    {
      "@type": "SoftwareApplication",
      "@id": APP_ID,
      name: SITE_NAME,
      description: SITE_DESCRIPTION,
      url: SITE_URL,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS",
      softwareVersion: manifest.version,
      downloadUrl: new URL("/download", SITE_URL).href,
      screenshot: screenshotUrl,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      publisher: { "@id": ORG_ID },
    },
    {
      "@type": "SoftwareSourceCode",
      "@id": `${GITHUB_REPO_URL}#source`,
      name: SITE_NAME,
      codeRepository: GITHUB_REPO_URL,
      license: `${GITHUB_REPO_URL}/blob/main/LICENSE`,
      programmingLanguage: "TypeScript",
      targetProduct: { "@id": APP_ID },
      publisher: { "@id": ORG_ID },
    },
  ];
}

/** Serializes nodes for a `<script type="application/ld+json">`, escaping `<` so no string can close the tag. */
export function toJsonLd(nodes: StructuredDataNode[]): string {
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": nodes });
  return json.replaceAll("<", "\\u003c");
}
