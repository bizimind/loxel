import { describe, expect, test } from "bun:test";

import { type CargoPackage, inlineCargoCrates, parseCargoPackages } from "./rust-inline-project";

const metadata = (packages: unknown[]) => JSON.stringify({ packages, workspace_members: [] });

describe("parseCargoPackages", () => {
  test("reads each package's targets, dependencies and features", () => {
    const packages = parseCargoPackages(
      metadata([
        {
          name: "app",
          version: "0.2.0",
          edition: "2021",
          manifest_path: "/wt/app/Cargo.toml",
          targets: [{ name: "app", kind: ["bin"], src_path: "/wt/app/src/main.rs" }],
          dependencies: [
            { name: "core", rename: "base", kind: null, path: "/wt/core" },
            { name: "serde", rename: null, kind: "dev", source: "registry+https://x" },
          ],
          features: { default: ["fast"], fast: [] },
        },
      ]),
    );
    expect(packages).toEqual([
      {
        name: "app",
        version: "0.2.0",
        manifestPath: "/wt/app/Cargo.toml",
        targets: [{ name: "app", kind: ["bin"], srcPath: "/wt/app/src/main.rs", edition: "2021" }],
        dependencies: [
          { name: "core", rename: "base", kind: null, path: "/wt/core" },
          { name: "serde", rename: null, kind: "dev", path: null },
        ],
        features: { default: ["fast"], fast: [] },
      },
    ]);
  });

  test("leaves out what is not a package, and reads nothing from what is not metadata", () => {
    expect(parseCargoPackages(metadata([{ name: "x" }, 3, { manifest_path: "a" }]))).toEqual([]);
    expect(parseCargoPackages("not json")).toEqual([]);
    expect(parseCargoPackages("{}")).toEqual([]);
  });

  test("leaves out a target in an edition rust-analyzer does not take, and odd feature names", () => {
    const [pkg] = parseCargoPackages(
      metadata([
        {
          name: "x",
          version: "1.0.0",
          edition: "future",
          manifest_path: "/wt/Cargo.toml",
          targets: [
            { name: "x", kind: ["lib"], src_path: "/wt/src/lib.rs" },
            { name: "y", kind: ["bin"], src_path: "/wt/src/main.rs", edition: "2021" },
          ],
          features: { default: [], 'a"b': [] },
        },
      ]),
    );
    expect(pkg?.targets.map((target) => target.name)).toEqual(["y"]);
    expect(pkg?.features).toEqual({ default: [] });
  });

  test("leaves out a target or a path that is not absolute", () => {
    const [pkg] = parseCargoPackages(
      metadata([
        {
          name: "x",
          version: "1.0.0",
          manifest_path: "/wt/Cargo.toml",
          targets: [{ name: "x", kind: ["lib"], src_path: "src/lib.rs" }],
          dependencies: [{ name: "y", kind: null, path: "../y" }],
        },
      ]),
    );
    expect(pkg?.targets).toEqual([]);
    expect(pkg?.dependencies).toEqual([{ name: "y", rename: null, kind: null, path: null }]);
  });
});

describe("inlineCargoCrates", () => {
  const core: CargoPackage = {
    name: "core-lib",
    version: "1.0.0",
    manifestPath: "/wt/core/Cargo.toml",
    targets: [{ name: "core_lib", kind: ["lib"], srcPath: "/wt/core/src/lib.rs", edition: "2021" }],
    dependencies: [],
    features: { default: ["std"], std: ["alloc", "dep:libc"], alloc: [], extra: [] },
  };
  const tools: CargoPackage = {
    name: "tools",
    version: "1.0.0",
    manifestPath: "/wt/tools/Cargo.toml",
    targets: [{ name: "tools", kind: ["lib"], srcPath: "/wt/tools/src/lib.rs", edition: "2021" }],
    dependencies: [],
    features: {},
  };
  const app: CargoPackage = {
    name: "app",
    version: "0.1.0",
    manifestPath: "/wt/app/Cargo.toml",
    targets: [
      { name: "app", kind: ["lib"], srcPath: "/wt/app/src/lib.rs", edition: "2024" },
      { name: "app", kind: ["bin"], srcPath: "/wt/app/src/main.rs", edition: "2024" },
      {
        name: "build-script-build",
        kind: ["custom-build"],
        srcPath: "/wt/app/build.rs",
        edition: "2024",
      },
    ],
    dependencies: [
      { name: "core-lib", rename: "base", kind: null, path: "/wt/core" },
      { name: "tools", rename: null, kind: "build", path: "/wt/tools" },
      { name: "serde", rename: null, kind: null, path: null },
    ],
    features: {},
  };

  test("links each target to the workspace libraries its package names by path", () => {
    const crates = inlineCargoCrates([core, tools, app]);
    expect(crates.map(({ root_module, deps }) => ({ root_module, deps }))).toEqual([
      { root_module: "/wt/core/src/lib.rs", deps: [] },
      { root_module: "/wt/tools/src/lib.rs", deps: [] },
      { root_module: "/wt/app/src/lib.rs", deps: [{ crate: 0, name: "base" }] },
      {
        root_module: "/wt/app/src/main.rs",
        deps: [
          { crate: 2, name: "app" },
          { crate: 0, name: "base" },
        ],
      },
      { root_module: "/wt/app/build.rs", deps: [{ crate: 1, name: "tools" }] },
    ]);
  });

  test("turns on the package's default features and its cargo variables", () => {
    const [crate] = inlineCargoCrates([core]);
    expect(crate).toEqual({
      display_name: "core_lib",
      root_module: "/wt/core/src/lib.rs",
      edition: "2021",
      deps: [],
      cfg: ["debug_assertions", 'feature="alloc"', 'feature="default"', 'feature="std"'],
      env: {
        CARGO_PKG_NAME: "core-lib",
        CARGO_PKG_VERSION: "1.0.0",
        CARGO_MANIFEST_DIR: "/wt/core",
        CARGO_CRATE_NAME: "core_lib",
      },
      is_workspace_member: true,
      is_proc_macro: false,
      source: { include_dirs: ["/wt/core"], exclude_dirs: ["/wt/core/target"] },
    });
  });
});
