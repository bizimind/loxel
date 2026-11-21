/**
 * Keeps mermaid diagrams from repositories inert. A diagram is a picture: it holds no links or
 * form controls, and it loads nothing from outside itself. References within the SVG (`#id`) and
 * inline `data:` URIs stay; every other URL in an attribute or in CSS is removed.
 */
import DOMPurify from "dompurify";

/** Elements a diagram never needs, and that could act on a click. */
const INTERACTIVE_TAGS = ["a", "form", "input", "button", "textarea", "select"];

/** Attributes whose value is a URL that the browser loads or follows. */
const URL_ATTRIBUTES = [
  "href",
  "xlink:href",
  "src",
  "srcset",
  "poster",
  "background",
  "action",
  "formaction",
  "ping",
  "data",
];
const URL_ATTRIBUTE_SET = new Set(URL_ATTRIBUTES);

/** Attributes that hold CSS, which can reference a URL with `url()`. */
const CSS_ATTRIBUTES = new Set([
  "style",
  "fill",
  "stroke",
  "filter",
  "clip-path",
  "mask",
  "marker-start",
  "marker-mid",
  "marker-end",
  "cursor",
]);

/**
 * How mermaid sanitizes label text as it draws, before its measuring render adds the diagram to
 * the document. Labels are text and math, so they keep no element that loads anything.
 */
export const MERMAID_LABEL_PURIFY_CONFIG = {
  FORBID_TAGS: [
    "style",
    ...INTERACTIVE_TAGS,
    "img",
    "image",
    "picture",
    "source",
    "video",
    "audio",
    "track",
  ],
  FORBID_ATTR: URL_ATTRIBUTES,
};

/** Whether a URL points inside the SVG itself or is inline data, so it loads nothing. */
function isLocalUrl(value: string): boolean {
  // CSS and HTML whitespace is ASCII only.
  const url = value.replace(/^[\t\n\f\r ]+/, "").toLowerCase();
  return url.startsWith("#") || url.startsWith("data:");
}

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*?))\s*(?:\)|$)/gi;
/** CSS functions and rules that load a resource from a plain string, without `url()`. */
const CSS_STRING_LOADERS = /(?:-webkit-)?image-set\s*\(|\bimage\s*\(|cross-fade\s*\(|@import/gi;
const CSS_ANY_URL = /url\s*\((?!\s*['"]?\s*(?:#|data:))/i;

/**
 * `css` with every non-local `url()` replaced by `none` and every other resource loader disabled,
 * or null if it cannot be made inert: CSS escapes can spell any of them, so CSS with a backslash
 * is not kept.
 */
export function inertCss(css: string): string | null {
  if (css.includes("\\")) return null;
  const inert = css
    .replace(CSS_URL, (match, double?: string, single?: string, bare?: string) =>
      isLocalUrl(double ?? single ?? bare ?? "") ? match : "none",
    )
    .replace(CSS_STRING_LOADERS, (loader) => `x-${loader.replace("@", "")}`);
  return CSS_ANY_URL.test(inert) ? null : inert;
}

/**
 * The value attribute `name` keeps in an inert diagram, or null to remove it: a URL only if it
 * loads nothing, and CSS (`style`, or a presentation attribute such as `fill`) made inert. Other
 * attributes hold text and are kept as they are.
 */
export function inertAttribute(name: string, value: string): string | null {
  if (URL_ATTRIBUTE_SET.has(name)) {
    // A srcset or ping holds several URLs, so its start says nothing of the rest.
    const single = name !== "srcset" && name !== "ping";
    return single && isLocalUrl(value) ? value : null;
  }
  return CSS_ATTRIBUTES.has(name) ? inertCss(value) : value;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
let purify: ReturnType<typeof DOMPurify> | null = null;

function inertPurify(): ReturnType<typeof DOMPurify> {
  if (purify) return purify;
  purify = DOMPurify();
  // The code block panel's rule (Crepe's `createSvgAwareSanitizer`): HTML only inside SVG.
  purify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "foreignobject" && node.parentElement?.namespaceURI !== SVG_NAMESPACE) {
      node.parentNode?.removeChild(node);
      return;
    }
    if (data.tagName === "style") node.textContent = inertCss(node.textContent ?? "") ?? "";
  });
  purify.addHook("uponSanitizeAttribute", (_node, data) => {
    const value = inertAttribute(data.attrName, data.attrValue);
    if (value === null) data.keepAttr = false;
    else data.attrValue = value;
  });
  return purify;
}

/** `svg`, rendered by mermaid, made inert for the preview and the full-size viewer. */
export function sanitizeMermaidSvg(svg: string): string {
  return inertPurify().sanitize(svg, {
    ADD_TAGS: ["foreignObject"],
    ADD_ATTR: ["xmlns"],
    FORBID_TAGS: INTERACTIVE_TAGS,
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  });
}
