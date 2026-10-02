import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LaunchServicesClient, appListCacheKey, normalizeAppList } from "./launch-services-client";
import type { LaunchServicesClientOptions } from "./launch-services-client";

/**
 * Stand-in for the real helper: speaks the same JSON-lines protocol. The request path picks
 * the behavior, and every app list reports the helper's pid and per-process call count.
 */
const FAKE_HELPER = `
let calls = 0;
for await (const line of console) {
  if (!line.trim()) continue;
  const req = JSON.parse(line);
  calls++;
  const target = req.path ?? req.appPath;
  // Die abruptly. SIGKILL rather than SIGSEGV: on Linux the JS engine handles SIGSEGV itself,
  // so a SIGSEGV sent with kill() does not terminate the process there.
  if (target.includes("crash")) process.kill(process.pid, "SIGKILL");
  if (target.includes("hang")) continue;
  const response = target.includes("fail")
    ? { id: req.id, ok: false, error: "boom" }
    : req.op === "apps"
      ? { id: req.id, ok: true, result: { defaultApp: "/Apps/Default.app", apps: ["/Apps/Zed.app", "/Apps/Default.app", "/Apps/pid-" + process.pid + "-call-" + calls + ".app"] } }
      : { id: req.id, ok: true, result: Buffer.from("png:" + calls).toString("base64") };
  process.stdout.write(JSON.stringify(response) + "\\n");
}
`;

let dir: string;
let helperScript: string;
const clients: LaunchServicesClient[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "launch-services-client-"));
  helperScript = join(dir, "fake-helper.ts");
  await Bun.write(helperScript, FAKE_HELPER);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

function createClient(options: Omit<LaunchServicesClientOptions, "command"> = {}) {
  const client = new LaunchServicesClient({
    command: [process.execPath, helperScript],
    ...options,
  });
  clients.push(client);
  return client;
}

async function touch(name: string, executable = false): Promise<string> {
  const path = join(dir, name);
  await Bun.write(path, "x");
  if (executable) await chmod(path, 0o755);
  return path;
}

/** The fake helper names one app `pid-<pid>-call-<n>.app`; extract both. */
function helperInfo(apps: { name: string }[]) {
  const match = apps.map((a) => /^pid-(\d+)-call-(\d+)$/.exec(a.name)).find(Boolean);
  if (!match) throw new Error("fake helper marker missing");
  return { pid: Number(match[1]), call: Number(match[2]) };
}

describe("normalizeAppList", () => {
  test("separates the default, drops nested bundles and duplicates, sorts by name", () => {
    const result = normalizeAppList({
      defaultApp: "/Applications/TextEdit.app",
      apps: [
        "/Applications/Xcode.app",
        "/Applications/TextEdit.app",
        "/Applications/Xcode.app/Contents/Applications/Instruments.app",
        "/Applications/Google Chrome.app",
        "/Applications/Xcode.app",
      ],
    });
    expect(result).toEqual({
      defaultApp: { path: "/Applications/TextEdit.app", name: "TextEdit" },
      apps: [
        { path: "/Applications/Google Chrome.app", name: "Google Chrome" },
        { path: "/Applications/Xcode.app", name: "Xcode" },
      ],
    });
  });

  test("handles a missing default app", () => {
    expect(normalizeAppList({ defaultApp: null, apps: [] })).toEqual({
      defaultApp: null,
      apps: [],
    });
  });
});

describe("appListCacheKey", () => {
  test("uses the lowercased extension", async () => {
    expect(await appListCacheKey("/x/README.MD")).toBe(".md");
    expect(await appListCacheKey("/x/archive.tar.gz")).toBe(".gz");
  });

  test("types extension-less files and dotfiles by their executable bit", async () => {
    expect(await appListCacheKey(await touch(".env"))).toBe("<none>");
    expect(await appListCacheKey(await touch("plain"))).toBe("<none>");
    expect(await appListCacheKey(await touch("script", true))).toBe("<executable>");
  });
});

describe("LaunchServicesClient", () => {
  test("returns normalized app lists and caches them per file type", async () => {
    const client = createClient();
    const first = await client.appsForFile("/repo/a.txt");
    expect(first.defaultApp).toEqual({ path: "/Apps/Default.app", name: "Default" });
    expect(first.apps.map((a) => a.name).at(-1)).toBe("Zed");

    const sameType = await client.appsForFile("/repo/B.TXT");
    expect(helperInfo(sameType.apps).call).toBe(1);
    const otherType = await client.appsForFile("/repo/c.md");
    expect(helperInfo(otherType.apps).call).toBe(2);
  });

  test("remembers which apps it listed", async () => {
    const client = createClient();
    expect(client.hasListedApp("/Apps/Zed.app")).toBe(false);
    await client.appsForFile("/repo/a.txt");
    expect(client.hasListedApp("/Apps/Zed.app")).toBe(true);
    expect(client.hasListedApp("/Apps/Default.app")).toBe(true);
    expect(client.hasListedApp("/Apps/Other.app")).toBe(false);
  });

  test("re-fetches app lists after the TTL", async () => {
    const client = createClient({ appListTtlMs: 0 });
    await client.appsForFile("/repo/a.txt");
    expect(helperInfo((await client.appsForFile("/repo/a.txt")).apps).call).toBe(2);
  });

  test("returns icons and caches them until the bundle changes", async () => {
    const client = createClient();
    const app = join(dir, "Icon.app");
    await mkdir(app, { recursive: true });

    expect(new TextDecoder().decode(await client.appIcon(app))).toBe("png:1");
    expect(new TextDecoder().decode(await client.appIcon(app))).toBe("png:1");
    const later = new Date(Date.now() + 60_000);
    await utimes(app, later, later);
    expect(new TextDecoder().decode(await client.appIcon(app))).toBe("png:2");
  });

  test("rejects with the helper's error message", async () => {
    const client = createClient();
    await expect(client.appsForFile("/repo/fail.txt")).rejects.toThrow("boom");
  });

  test("survives a helper crash and restarts it on the next request", async () => {
    const client = createClient();
    const before = helperInfo((await client.appsForFile("/repo/a.txt")).apps);

    await expect(client.appsForFile("/repo/crash.md")).rejects.toThrow(
      "LaunchServices helper exited (SIGKILL)",
    );

    const after = helperInfo((await client.appsForFile("/repo/b.json")).apps);
    expect(after.pid).not.toBe(before.pid);
  });

  test("times out a wedged helper and replaces it", async () => {
    const client = createClient({ requestTimeoutMs: 200 });
    const before = helperInfo((await client.appsForFile("/repo/a.txt")).apps);

    await expect(client.appsForFile("/repo/hang.md")).rejects.toThrow("timed out");

    const after = helperInfo((await client.appsForFile("/repo/b.json")).apps);
    expect(after.pid).not.toBe(before.pid);
  });

  test("stops an idle helper and starts a new one when needed", async () => {
    const client = createClient({ idleTimeoutMs: 50 });
    const before = helperInfo((await client.appsForFile("/repo/a.txt")).apps);
    await Bun.sleep(300);
    expect(() => process.kill(before.pid, 0)).toThrow();

    const after = helperInfo((await client.appsForFile("/repo/b.json")).apps);
    expect(after.pid).not.toBe(before.pid);
  });

  test("serves concurrent requests from one helper", async () => {
    const client = createClient();
    const results = await Promise.all(
      [".a", ".b", ".c", ".d", ".e"].map((ext) => client.appsForFile(`/repo/file${ext}`)),
    );
    expect(new Set(results.map((r) => helperInfo(r.apps).pid)).size).toBe(1);
  });
});
