// Integration test against real macOS LaunchServices: starts the helper exactly like
// production does (the server entry point re-run with LAUNCH_SERVICES_HELPER_FLAG).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LaunchServicesClient } from "./launch-services-client";
import { LAUNCH_SERVICES_HELPER_FLAG } from "./launch-services-protocol";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const TEXT_EDIT = "/System/Applications/TextEdit.app";

describe.skipIf(process.platform !== "darwin")("LaunchServices helper (macOS)", () => {
  let dir: string;
  let client: LaunchServicesClient;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "launch-services-helper-"));
    client = new LaunchServicesClient({
      command: [process.execPath, join(import.meta.dir, "index.ts"), LAUNCH_SERVICES_HELPER_FLAG],
    });
  });
  afterAll(async () => {
    client.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  test("lists TextEdit among the apps for a .txt file", async () => {
    const file = join(dir, "note.txt");
    await Bun.write(file, "hello");
    const { defaultApp, apps } = await client.appsForFile(file);
    const all = [defaultApp, ...apps].flatMap((app) => (app ? [app.path] : []));
    expect(all).toContain(TEXT_EDIT);
  });

  test("renders an app icon as PNG", async () => {
    const png = await client.appIcon(TEXT_EDIT);
    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  });
});
