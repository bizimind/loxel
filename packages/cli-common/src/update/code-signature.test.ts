import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CODESIGN, releaseCodeRequirement, verifyCodeSignature } from "./code-signature.ts";

test("the requirement pins the Developer ID team and the package's identifier", () => {
  const requirement = releaseCodeRequirement("wt");
  expect(requirement).toContain('certificate leaf[subject.OU] = "JJ88G244AR"');
  expect(requirement).toContain('identifier "com.bizimind.wt"');
});

describe.skipIf(process.platform !== "darwin")("verifyCodeSignature", () => {
  test("rejects a binary Apple signed", async () => {
    await expect(verifyCodeSignature("/bin/ls", "wt")).rejects.toThrow(
      "failed the release code signature check",
    );
  });

  test("rejects an ad-hoc signed binary", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "code-signature-"));
    try {
      const binary = path.join(dir, "wt");
      await copyFile("/bin/ls", binary);
      const signed = Bun.spawnSync([CODESIGN, "--force", "--sign", "-", binary], {
        stderr: "ignore",
      });
      expect(signed.exitCode).toBe(0);
      await expect(verifyCodeSignature(binary, "wt")).rejects.toThrow(
        "failed the release code signature check",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
