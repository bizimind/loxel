import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  legacyNpmLicense,
  withDepsDevLicenses,
  withLicenseOverrides,
  withNpmLegacyLicenses,
} from "./sbom-licenses";

describe("legacyNpmLicense", () => {
  test("reads a licenses array as a choice", () => {
    expect(
      legacyNpmLicense({ licenses: [{ type: "MIT", url: "x" }, { type: "Apache-2.0" }] }),
    ).toBe("MIT OR Apache-2.0");
  });

  test("reads a license object", () => {
    expect(legacyNpmLicense({ license: { type: "BSD-3-Clause" } })).toBe("BSD-3-Clause");
  });

  test("is undefined without either", () => {
    expect(legacyNpmLicense({ license: "MIT" })).toBeUndefined();
    expect(legacyNpmLicense({ licenses: [] })).toBeUndefined();
  });
});

describe("withNpmLegacyLicenses", () => {
  test("finds a scoped package stored with its peers' suffix", async () => {
    const store = mkdtempSync(path.join(os.tmpdir(), "pnpm-store-test-"));
    const dir = path.join(store, "@scope+pkg@1.0.0_react@19.0.0", "node_modules", "@scope", "pkg");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ licenses: [{ type: "MIT" }] }));
    const component = {
      "bom-ref": "pkg:npm/%40scope/pkg@1.0.0",
      group: "@scope",
      name: "pkg",
      version: "1.0.0",
      purl: "pkg:npm/%40scope/pkg@1.0.0",
    };
    const [result] = await withNpmLegacyLicenses([component], store);
    rmSync(store, { recursive: true, force: true });
    expect(result?.licenses).toEqual([{ expression: "MIT" }]);
  });
});

describe("withDepsDevLicenses", () => {
  const go = {
    "bom-ref": "pkg:golang/example.com/x@v1.0.0",
    name: "example.com/X",
    version: "v1.0.0",
    purl: "pkg:golang/example.com/x@v1.0.0",
  };
  const maven = {
    "bom-ref": "pkg:maven/ch.qos.logback/logback-core@1.6.3",
    group: "ch.qos.logback",
    name: "logback-core",
    version: "1.6.3",
    purl: "pkg:maven/ch.qos.logback/logback-core@1.6.3",
  };

  test("ANDs a Go module's licenses and ORs a POM's", async () => {
    const urls: string[] = [];
    const result = await withDepsDevLicenses([go, maven], async (url) => {
      urls.push(url);
      return url.includes("/go/") ? ["MIT", "Apache-2.0 OR MIT"] : ["EPL-2.0", "LGPL-2.1-only"];
    });
    expect(urls.toSorted()).toEqual([
      "https://api.deps.dev/v3/systems/go/packages/example.com%2FX/versions/v1.0.0",
      "https://api.deps.dev/v3/systems/maven/packages/ch.qos.logback%3Alogback-core/versions/1.6.3",
    ]);
    expect(result.map((component) => component.licenses)).toEqual([
      [{ expression: "MIT AND (Apache-2.0 OR MIT)" }],
      [{ expression: "EPL-2.0 OR LGPL-2.1-only" }],
    ]);
  });

  test("leaves a component unlicensed, with a warning, when the lookup fails", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const result = await withDepsDevLicenses([go], () => Promise.reject(new Error("offline")));
    expect(result).toEqual([go]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("skips components that have a license or are no Go module or Maven artifact", async () => {
    const licensed = { ...go, licenses: [{ expression: "MIT" }] };
    const npm = { "bom-ref": "pkg:npm/x@1.0.0", purl: "pkg:npm/x@1.0.0" };
    const result = await withDepsDevLicenses([licensed, npm], () => {
      throw new Error("not looked up");
    });
    expect(result).toEqual([licensed, npm]);
  });
});

describe("withLicenseOverrides", () => {
  const khroma = { "bom-ref": "pkg:npm/khroma@2.1.0" };
  const elkjs = {
    "bom-ref": "pkg:npm/elkjs@0.12.1",
    licenses: [{ expression: "EPL-2.0 OR GPL-3.0-or-later" }],
  };

  test("declares a missing license", () => {
    const [result] = withLicenseOverrides([khroma], {
      "pkg:npm/khroma@2.1.0": { license: "MIT", note: "" },
    });
    expect(result?.licenses).toEqual([{ expression: "MIT" }]);
  });

  test("records a concluded license beside the declared one", () => {
    const [result] = withLicenseOverrides([elkjs], {
      "pkg:npm/elkjs@0.12.1": { concluded: "EPL-2.0", note: "" },
    });
    expect(result?.licenses).toEqual([
      { expression: "EPL-2.0 OR GPL-3.0-or-later", acknowledgement: "declared" },
      { expression: "EPL-2.0", acknowledgement: "concluded" },
    ]);
  });

  test("refuses an override that matches no component, as after a version bump", () => {
    expect(() =>
      withLicenseOverrides([khroma], { "pkg:npm/khroma@2.0.0": { license: "MIT", note: "" } }),
    ).toThrow("pkg:npm/khroma@2.0.0");
  });
});
