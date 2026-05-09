import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProvider } from "../src/create-provider.ts";
import { detectPreferredProvider } from "../src/detect.ts";
import { SandboxError } from "../src/errors.ts";
import { SandboxTemplate } from "../src/sandbox-template.ts";

const providerType = detectPreferredProvider();

// Actually verify the provider is ready (not just that the binary exists)
let SKIP = !providerType;
if (providerType && !SKIP) {
  try {
    const provider = createProvider(providerType);
    await provider.ensureReady();
  } catch {
    SKIP = true;
  }
}

describe.skipIf(SKIP)("integration", () => {
  test("full lifecycle: create, exec, spawn, inspect, logs, find, restart, destroy", async () => {
    const template = new SandboxTemplate(
      {
        name: "sandbox-test",
        image: "alpine:latest",
        command: ["sleep", "60"],
        labels: { "sandbox.test": "integration" },
      },
      { providerType: providerType! },
    );

    const sandbox = await template.create();

    try {
      expect(sandbox.id).toBeTruthy();

      // exec
      const result = await sandbox.exec(["echo", "hello from sandbox"]);
      expect(result.stdout.trim()).toBe("hello from sandbox");

      // inspect
      const info = await sandbox.inspect();
      expect(info.state).toBe("running");
      expect(info.labels["sandbox.test"]).toBe("integration");

      // isRunning
      expect(await sandbox.isRunning()).toBe(true);

      // logs
      const logs = await sandbox.logs();
      expect(typeof logs).toBe("string");

      // find by label
      const found = await template.find({ label: { "sandbox.test": "integration" } });
      expect(found.some((s) => s.id === sandbox.id)).toBe(true);

      // attach
      const attached = await template.attach(sandbox.name);
      expect(attached.id).toBe(sandbox.id);

      // streaming spawn
      const handle = sandbox.spawn(["sh", "-c", "echo streamed"]);
      const out = await new Response(handle.stdout).text();
      await handle.exited;
      expect(out.trim()).toBe("streamed");

      // restart
      await sandbox.restart({ timeout: 2 });
      expect(await sandbox.isRunning()).toBe(true);

      // copyTo/copyFrom — docker/podman only
      if (sandbox.provider.type !== "apple") {
        const dir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
        try {
          const srcPath = join(dir, "file.txt");
          const dstPath = join(dir, "file-out.txt");
          await writeFile(srcPath, "roundtrip\n");
          await sandbox.copyTo(srcPath, "/tmp/file.txt");
          await sandbox.copyFrom("/tmp/file.txt", dstPath);
          const read = await readFile(dstPath, "utf8");
          expect(read).toBe("roundtrip\n");
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      } else {
        await expect(sandbox.copyTo("/tmp", "/tmp")).rejects.toMatchObject({ code: "unsupported" });
      }
    } finally {
      await sandbox.destroy();
    }

    // Destroyed sandbox: methods reject
    await expect(sandbox.exec(["echo"])).rejects.toBeInstanceOf(SandboxError);
  }, 120_000);
});
