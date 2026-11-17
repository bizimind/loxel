import { describe, expect, test } from "bun:test";
import path from "node:path";

import { manifestVersion, pinnedGoModuleVersion } from "./language-server-manifest";

describe("pinnedGoModuleVersion", () => {
  test.each([
    ["gopls", "gopls-module", "golang.org/x/tools/gopls"],
    ["docker-language-server", "docker-lsp-module", "github.com/docker/docker-language-server"],
    ["terraform-ls", "terraform-ls-module", "github.com/hashicorp/terraform-ls"],
  ])("%s's pinned go.mod requires its manifest's version", async (name, dir, modulePath) => {
    const version = await pinnedGoModuleVersion(name, path.join(import.meta.dir, dir), modulePath);
    expect(version).toBe(`v${await manifestVersion(name)}`);
  });

  test("throws when the manifest names another version", async () => {
    const goplsModule = path.join(import.meta.dir, "gopls-module");
    await expect(
      pinnedGoModuleVersion("terraform-ls", goplsModule, "golang.org/x/tools/gopls"),
    ).rejects.toThrow("but terraform-ls.json says");
  });
});
