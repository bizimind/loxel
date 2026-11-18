import { describe, expect, test } from "bun:test";

import { electronVersion } from "./electron-dist";
import { readManifests, shippedComponent } from "./language-server-manifest";
import {
  type Bom,
  bunAdditions,
  bunComponent,
  checkNpmDependencies,
  electronAdditions,
  generateSbom,
  goAdditions,
  jarAdditions,
  readThirdParty,
  sorted,
  withComponents,
} from "./sbom";

const npmManifest = {
  name: "x",
  script: "build-x.ts",
  resources: ["x"],
  npm: ["x-server"] as [string],
};

describe("generateSbom", () => {
  test("lists the lockfile's packages, Electron, Bun and every language server, licensed", async () => {
    const bom = await generateSbom(process.versions);
    const names = new Set(
      bom.components.map((component) =>
        typeof component.group === "string"
          ? `${component.group}/${component.name}`
          : component.name,
      ),
    );
    expect(names).toContain("react");
    expect(names).toContain("electron");
    expect(names).toContain("chromium");
    expect(names).toContain("bun");
    expect(names).toContain("webkit");
    expect(names).toContain("Inter");
    // Shipped as generated CSS, so a dependency rather than a devDependency.
    expect(names).toContain("tailwindcss");
    // The tsc Loxel ships, from this machine's platform package (generateSbom itself refuses a
    // manifest's npm package that is not a dependency).
    expect(names).toContain(`@typescript/typescript-${process.platform}-${process.arch}`);
    for (const manifest of await readManifests()) {
      const shipped = shippedComponent(manifest);
      if (shipped) expect(names).toContain(shipped.name);
    }
    // Every override in third-party.json matched (generateSbom throws otherwise), and fuzzy's
    // legacy `licenses` was read.
    expect(bom.components.filter((component) => !component.licenses)).toEqual([]);
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
    const result = withComponents(bom, [{ component: bunComponent("1.4.3") }]);
    expect(result.components.map((c) => c["bom-ref"])).toEqual([
      "a",
      "pkg:github/oven-sh/bun@bun-v1.4.3",
    ]);
    expect(result.dependencies).toEqual([
      { ref: "root", dependsOn: ["a", "pkg:github/oven-sh/bun@bun-v1.4.3"] },
    ]);
  });

  test("adds a component as a dependency of its parents", () => {
    const result = withComponents(bom, [{ component: { "bom-ref": "b" }, parents: ["a", "root"] }]);
    expect(result.dependencies).toEqual([
      { ref: "root", dependsOn: ["a", "b"] },
      { ref: "a", dependsOn: ["b"] },
    ]);
  });

  test("refuses a component that is already listed", () => {
    expect(() => withComponents(bom, [{ component: { "bom-ref": "a" } }])).toThrow("listed twice");
  });
});

describe("goAdditions", () => {
  const binary = (goVersion: string, deps: [string, string][], main?: [string, string]) => ({
    goVersion,
    main: main && { path: main[0], version: main[1] },
    deps: deps.map(([modPath, version]) => ({ path: modPath, version })),
  });

  test("lists each binary's stdlib and modules under it, once per module", () => {
    const additions = goAdditions(
      [
        {
          file: "x-ls",
          info: binary(
            "go1.26.4",
            [["github.com/BurntSushi/toml", "v1.6.0"]],
            ["example.com/x", "(devel)"],
          ),
        },
        {
          file: "y/y-ls",
          info: binary("go1.26.4", [
            ["github.com/docker/docker", "v28.4.0+incompatible"],
            ["github.com/BurntSushi/toml", "v1.6.0"],
          ]),
        },
      ],
      (file) => `parent:${file.split("/")[0]}`,
      new Set(),
    );
    expect(additions.map((a) => [a.component["bom-ref"], a.parents])).toEqual([
      ["pkg:golang/stdlib@v1.26.4", ["parent:x-ls", "parent:y"]],
      ["pkg:golang/github.com/burntsushi/toml@v1.6.0", ["parent:x-ls", "parent:y"]],
      ["pkg:golang/github.com/docker/docker@v28.4.0%2Bincompatible", ["parent:y"]],
    ]);
  });

  test("leaves out the binary's own component", () => {
    const additions = goAdditions(
      [
        {
          file: "x-ls",
          info: binary("go1.27.4", [["example.com/x", "v1.0.0"]], ["example.com/x", "v1.0.0"]),
        },
      ],
      () => "pkg:golang/example.com/x@v1.0.0",
      new Set(),
    );
    expect(additions.map((a) => a.component["bom-ref"])).toEqual(["pkg:golang/stdlib@v1.27.4"]);
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

describe("electronAdditions", () => {
  const bundled = {
    version: "45.3.0",
    note: "",
    components: [{ name: "chromium", version: "156.0.1", license: "BSD-3-Clause", url: "u" }],
  };

  test("lists what Electron bundles under it, and its license covers theirs", () => {
    const [electron, chromium] = electronAdditions("45.3.0", [], "1.0.0", bundled);
    expect(electron?.component.licenses).toEqual([{ expression: "MIT AND BSD-3-Clause" }]);
    expect(chromium?.component).toMatchObject({ name: "chromium", version: "156.0.1" });
    expect(chromium?.parents).toEqual(["pkg:npm/electron@45.3.0"]);
  });

  test("refuses a third-party.json that lists another Electron", () => {
    expect(() => electronAdditions("46.0.0", [], "1.0.0", bundled)).toThrow("pins 46.0.0");
  });

  test("third-party.json lists the pinned Electron", async () => {
    const packageJson: unknown = await Bun.file(`${import.meta.dir}/../package.json`).json();
    const { electron } = await readThirdParty();
    expect(electron.version).toBe(electronVersion(packageJson));
  });
});

describe("bunAdditions", () => {
  const bundled = {
    note: "",
    components: [
      {
        name: "webkit",
        versionKey: "webkit",
        purl: "pkg:github/oven-sh/webkit@{version}",
        license: "LGPL-2.0-or-later AND BSD-2-Clause",
        url: "u",
      },
      { name: "brotli", license: "MIT", url: "u" },
    ],
  };

  test("takes the versions the shipped Bun reports", () => {
    const additions = bunAdditions({ bun: "1.4.4", webkit: "abc" }, bundled);
    expect(additions.map(({ component }) => component["bom-ref"])).toEqual([
      "pkg:github/oven-sh/bun@bun-v1.4.4",
      "pkg:github/oven-sh/webkit@abc",
      "brotli",
    ]);
    expect(additions[0]?.component.licenses).toEqual([
      { expression: "MIT AND (LGPL-2.0-or-later AND BSD-2-Clause)" },
    ]);
  });

  test("refuses a version key the shipped Bun no longer reports", () => {
    expect(() => bunAdditions({ bun: "1.4.4" }, bundled)).toThrow("process.versions.webkit");
  });
});

describe("jarAdditions", () => {
  test("lists each artifact once under its server, without the server's own snapshots", () => {
    const guava = { groupId: "com.google.guava", artifactId: "guava", version: "33.7.1-jre" };
    const additions = jarAdditions(
      [
        { file: "jdtls/plugins/a.jar", coordinates: [guava] },
        {
          file: "jdtls/plugins/b.jar",
          coordinates: [guava, { groupId: "x", artifactId: "y", version: "1.0.0-SNAPSHOT" }],
        },
      ],
      (file) => `parent:${file.split("/")[0]}`,
      new Set(),
    );
    expect(additions).toEqual([
      {
        component: {
          type: "library",
          "bom-ref": "pkg:maven/com.google.guava/guava@33.7.1-jre",
          group: "com.google.guava",
          name: "guava",
          version: "33.7.1-jre",
          purl: "pkg:maven/com.google.guava/guava@33.7.1-jre",
        },
        parents: ["parent:jdtls"],
      },
    ]);
  });
});

describe("sorted", () => {
  test("orders components and dependencies by ref", () => {
    const bom: Bom = {
      metadata: { component: { "bom-ref": "root", version: "1.0.0" } },
      components: [{ "bom-ref": "b" }, { "bom-ref": "a" }],
      dependencies: [{ ref: "root", dependsOn: ["b", "a"] }, { ref: "a" }],
    };
    expect(sorted(bom)).toEqual({
      ...bom,
      components: [{ "bom-ref": "a" }, { "bom-ref": "b" }],
      dependencies: [{ ref: "a" }, { ref: "root", dependsOn: ["a", "b"] }],
    });
  });
});
