import { describe, expect, test } from "bun:test";

import { readManifests, shippedComponent } from "./language-server-manifest";
import { type Bom, bunComponent, checkNpmDependencies, generateSbom, withComponents } from "./sbom";

const npmManifest = {
  name: "x",
  script: "build-x.ts",
  resources: ["x"],
  npm: ["x-server"] as [string],
};

describe("generateSbom", () => {
  test("lists the lockfile's packages, Electron, Bun and every language server", async () => {
    const bom = await generateSbom();
    const names = new Set(
      bom.components.map((component) =>
        typeof component.group === "string"
          ? `${component.group}/${component.name}`
          : component.name,
      ),
    );
    expect(names).toContain("react");
    expect(names).toContain("electron");
    expect(names).toContain("bun");
    // The tsc Loxel ships, from this machine's platform package (generateSbom itself refuses a
    // manifest's npm package that is not a dependency).
    expect(names).toContain(`@typescript/typescript-${process.platform}-${process.arch}`);
    for (const manifest of await readManifests()) {
      const shipped = shippedComponent(manifest);
      if (shipped) expect(names).toContain(shipped.name);
    }
    // It runs pnpm, so give a slow machine room.
  }, 30_000);
});

describe("shippedComponent", () => {
  test("fills the version into the purl and source", () => {
    expect(
      shippedComponent({
        ...npmManifest,
        version: "1.2.3",
        purl: "pkg:golang/example.com/x/tools/x@v{version}",
        license: "MIT",
        source: "https://example.com/x/tree/v{version}",
      }),
    ).toEqual({
      name: "x",
      version: "1.2.3",
      purl: "pkg:golang/example.com/x/tools/x@v1.2.3",
      license: "MIT",
      source: "https://example.com/x/tree/v1.2.3",
    });
  });

  test("is undefined for a server built only from npm packages", () => {
    expect(shippedComponent(npmManifest)).toBeUndefined();
  });
});

describe("withComponents", () => {
  const bom: Bom = {
    metadata: { component: { "bom-ref": "root", version: "1.0.0" } },
    components: [{ "bom-ref": "a" }],
    dependencies: [{ ref: "root", dependsOn: ["a"] }],
  };

  test("adds the components as dependencies of the root", () => {
    const result = withComponents(bom, [bunComponent("1.4.3")]);
    expect(result.components.map((c) => c["bom-ref"])).toEqual([
      "a",
      "pkg:github/oven-sh/bun@bun-v1.4.3",
    ]);
    expect(result.dependencies).toEqual([
      { ref: "root", dependsOn: ["a", "pkg:github/oven-sh/bun@bun-v1.4.3"] },
    ]);
  });

  test("refuses a component that is already listed", () => {
    expect(() => withComponents(bom, [{ "bom-ref": "a" }])).toThrow("listed twice");
  });
});

describe("checkNpmDependencies", () => {
  test("accepts packages in dependencies", () => {
    expect(() =>
      checkNpmDependencies([npmManifest], { dependencies: { "x-server": "1.0.0" } }),
    ).not.toThrow();
  });

  test("refuses a package that is only a devDependency", () => {
    expect(() =>
      checkNpmDependencies([npmManifest], {
        dependencies: {},
        devDependencies: { "x-server": "1.0.0" },
      }),
    ).toThrow("x-server (x.json)");
  });
});
