import { describe, expect, test } from "bun:test";

import { inertAttribute, inertCss } from "./mermaid-sanitizer";

describe("inertCss", () => {
  test("keeps references inside the SVG and inline data", () => {
    const css =
      "#d .arrow { marker-end: url(#arrowhead); fill: url('#grad'); background: url(data:image/png;base64,AA==) }";
    expect(inertCss(css)).toBe(css);
  });

  test("replaces web and relative url() with none", () => {
    expect(inertCss("a { background: url(https://example.com/a.png) }")).toBe(
      "a { background: none }",
    );
    expect(inertCss('a { background: URL( "/api/version" ) }')).toBe("a { background: none }");
    expect(inertCss("a { cursor: url(//example.com/c), auto }")).toBe("a { cursor: none, auto }");
    expect(inertCss("background: url(https://example.com/a.png")).toBe("background: none");
  });

  test("turns off imports and image functions that load plain strings", () => {
    expect(inertCss('@import "https://example.com/x.css";')).toBe(
      'x-import "https://example.com/x.css";',
    );
    expect(inertCss('a { background: image-set("https://example.com/a.png" 1x) }')).toBe(
      'a { background: x-image-set("https://example.com/a.png" 1x) }',
    );
  });

  test("keeps no CSS with escapes or an unterminated url()", () => {
    expect(inertCss("a { background: u\\72l(https://example.com/a.png) }")).toBeNull();
    expect(inertCss('a { background: url("https://example.com/a.png')).toBeNull();
  });
});

describe("inertAttribute", () => {
  test("keeps URLs that point inside the diagram or are inline data", () => {
    expect(inertAttribute("href", "#arrow")).toBe("#arrow");
    expect(inertAttribute("xlink:href", " #arrow")).toBe(" #arrow");
    expect(inertAttribute("src", "data:image/png;base64,AA==")).toBe("data:image/png;base64,AA==");
  });

  test("removes URLs that load or lead anywhere else", () => {
    for (const [name, value] of [
      ["href", "https://example.com"],
      ["xlink:href", "http://127.0.0.1:7433/api/version"],
      ["src", "/api/version"],
      ["src", "//example.com/a.png"],
      ["poster", "https://example.com/p.png"],
      ["background", "https://example.com/b.png"],
      ["srcset", "data:image/png;base64,AA== 1x, https://example.com/b.png 2x"],
    ]) {
      expect(inertAttribute(name!, value!)).toBeNull();
    }
  });

  test("makes style and presentation attributes load nothing", () => {
    expect(inertAttribute("style", "fill: red; background: url(https://example.com/h)")).toBe(
      "fill: red; background: none",
    );
    expect(inertAttribute("fill", "url(https://example.com/g)")).toBe("none");
    expect(inertAttribute("marker-end", "url(#arrow)")).toBe("url(#arrow)");
    expect(inertAttribute("class", "node default")).toBe("node default");
    expect(inertAttribute("aria-label", "see url(x)")).toBe("see url(x)");
  });
});
