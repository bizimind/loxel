import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

/**
 * Mermaid bundles elkjs (EPL-2.0) into a renderer chunk with its license comments minified away,
 * so the notice in public/assets ships beside that chunk. It names the elkjs version it covers.
 */
describe("elkjs license notice", () => {
  test("names the elkjs version mermaid bundles", async () => {
    const mermaidDir = dirname(Bun.resolveSync("mermaid", import.meta.dir));
    const elkPackage = Bun.resolveSync("elkjs/package.json", mermaidDir);
    const manifest: unknown = await Bun.file(elkPackage).json();
    const version =
      typeof manifest === "object" && manifest !== null && "version" in manifest
        ? String(manifest.version)
        : "";
    expect(version).not.toBe("");
    const notice = await Bun.file(
      join(import.meta.dir, "../../../public/assets/LICENSE-elkjs.txt"),
    ).text();
    expect(notice).toStartWith(`elkjs ${version} `);
    expect(notice).toContain(`https://github.com/kieler/elkjs/tree/${version}`);
    expect(notice).toContain("Eclipse Public License - v 2.0");
  });
});
