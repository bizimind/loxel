import { describe, expect, test } from "bun:test";
import path from "node:path";

import { manifestVersion, readManifest, shippedComponent } from "./language-server-manifest";

describe("readManifest", () => {
  test.each([
    ["gopls", "gopls-module", "golang.org/x/tools/gopls"],
    ["terraform-ls", "terraform-ls-module", "github.com/hashicorp/terraform-ls"],
  ])("%s takes its version from the go.mod that pins it", async (name, dir, modulePath) => {
    const goMod = await Bun.file(path.join(import.meta.dir, dir, "go.mod")).text();
    const version = await manifestVersion(name);
    expect(goMod).toContain(`${modulePath} v${version}`);
    const component = shippedComponent(await readManifest(name));
    expect(component?.purl).toBe(`pkg:golang/${modulePath}@v${version}`);
  });
});
