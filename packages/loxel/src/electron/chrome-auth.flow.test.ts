import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { PassThrough } from "node:stream";

import type { ElectronCookieDetails } from "./chrome-auth";
import {
  ChromeAuthManager,
  type ChromeAuthConfirmation,
  type ChromeLauncher,
  type ChromeProcess,
} from "./chrome-auth";

type Responder = (method: string, params: Record<string, unknown>) => unknown;

/** A Chrome stand-in speaking the DevTools pipe protocol with scripted answers. */
class FakeChrome implements ChromeProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly commandStream = new PassThrough();
  readonly responseStream = new PassThrough();
  readonly calls: string[] = [];
  private readonly listeners = { exit: new Set<() => void>(), error: new Set<() => void>() };
  private buffer = "";

  constructor(private readonly respond: Responder) {
    this.commandStream.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let boundary = this.buffer.indexOf("\0");
      while (boundary !== -1) {
        const frame = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 1);
        this.handle(
          JSON.parse(frame) as { id: number; method: string; params: Record<string, unknown> },
        );
        boundary = this.buffer.indexOf("\0");
      }
    });
  }

  private handle(command: { id: number; method: string; params: Record<string, unknown> }): void {
    this.calls.push(command.method);
    if (command.method === "Browser.close") {
      this.responseStream.write(`${JSON.stringify({ id: command.id, result: {} })}\0`);
      this.exit(0);
      return;
    }
    const result = this.respond(command.method, command.params);
    this.responseStream.write(`${JSON.stringify({ id: command.id, result })}\0`);
  }

  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.responseStream.end();
    for (const listener of this.listeners.exit) listener();
  }

  failToLaunch(): void {
    for (const listener of this.listeners.error) listener();
    this.responseStream.end();
  }

  kill(signal: NodeJS.Signals): void {
    this.signalCode = signal;
    this.exit(-1);
  }

  on(event: "exit" | "error", listener: () => void): void {
    this.listeners[event].add(listener);
  }

  off(event: "exit" | "error", listener: () => void): void {
    this.listeners[event].delete(listener);
  }
}

function page(targetId: string, url: string) {
  return { targetId, type: "page", url };
}

const START = "https://accounts.example.com/";
const cookie = (name: string, domain: string) => ({
  name,
  value: "v",
  domain,
  path: "/",
  secure: true,
  httpOnly: true,
  session: true,
  sameSite: "Lax",
});

function harness(respond: Responder, options: { launchFails?: boolean } = {}) {
  const launches: Array<{ profileDir: string; url: string }> = [];
  let chrome: FakeChrome | null = null;
  const launcher: ChromeLauncher = {
    findExecutable: async () => "/fake/chrome",
    launch(_executable, profileDir, url) {
      launches.push({ profileDir, url });
      chrome = new FakeChrome(respond);
      if (options.launchFails) queueMicrotask(() => chrome?.failToLaunch());
      return chrome;
    },
  };
  const imported: ElectronCookieDetails[] = [];
  const manager = new ChromeAuthManager(
    { set: async (details) => void imported.push(details), flushStore: async () => {} },
    launcher,
  );
  const confirm = (answers: Partial<ChromeAuthConfirmation> = {}): ChromeAuthConfirmation => ({
    confirmImport: async () => true,
    confirmOriginChange: async () => true,
    ...answers,
  });
  return { manager, launches, imported, confirm, chrome: () => chrome! };
}

async function profileExists(dir: string): Promise<boolean> {
  return stat(dir).then(
    () => true,
    () => false,
  );
}

describe("ChromeAuthManager", () => {
  test("imports the cookies of the tab the sign-in finished on", async () => {
    let confirmed = false;
    const h = harness((method) => {
      if (method === "Target.getTargets") {
        return {
          targetInfos: confirmed
            ? [page("t2", "https://app.example.com/home")]
            : [page("t1", START)],
        };
      }
      if (method === "Storage.getCookies") {
        return { cookies: [cookie("sid", ".example.com"), cookie("other", "unrelated.test")] };
      }
      return {};
    });

    const result = await h.manager.authenticate(
      START,
      h.confirm({
        confirmImport: async () => {
          confirmed = true;
          return true;
        },
      }),
    );

    expect(result).toEqual({
      status: "success",
      finalUrl: "https://app.example.com/home",
      importedCount: 1,
      skippedCount: 1,
      persistence: "persistent",
    });
    expect(h.imported.map((c) => c.name)).toEqual(["sid"]);
    expect(h.launches[0]!.url).toBe(START);
    expect(h.chrome().calls).toContain("Browser.close");
    expect(await profileExists(h.launches[0]!.profileDir)).toBe(false);
    expect(h.manager.isActive).toBe(false);
  });

  test("refuses to guess between several extra tabs", async () => {
    let confirmed = false;
    const h = harness((method) =>
      method === "Target.getTargets"
        ? {
            targetInfos: confirmed
              ? [page("t2", "https://a.example.com/"), page("t3", "https://b.example.com/")]
              : [page("t1", START)],
          }
        : {},
    );

    const result = await h.manager.authenticate(
      START,
      h.confirm({
        confirmImport: async () => {
          confirmed = true;
          return true;
        },
      }),
    );

    expect(result).toMatchObject({ status: "error", code: "extra-tabs" });
    expect(h.imported).toEqual([]);
    expect(await profileExists(h.launches[0]!.profileDir)).toBe(false);
  });

  test("cancelling mid-flow closes Chrome and removes the profile", async () => {
    const h = harness((method) =>
      method === "Target.getTargets" ? { targetInfos: [page("t1", START)] } : {},
    );
    const waiting = Promise.withResolvers<boolean>();
    const flow = h.manager.authenticate(START, h.confirm({ confirmImport: () => waiting.promise }));

    // The prompt is up; a second request is refused while the first is active.
    await Bun.sleep(50);
    expect(h.manager.isActive).toBe(true);
    expect(await h.manager.authenticate(START, h.confirm())).toMatchObject({
      status: "error",
      code: "busy",
    });

    await h.manager.cancelActive();
    expect(await flow).toEqual({ status: "cancelled" });
    expect(h.chrome().exitCode).not.toBeNull();
    expect(await profileExists(h.launches[0]!.profileDir)).toBe(false);
    expect(h.manager.isActive).toBe(false);
  });

  test("a Chrome that fails to launch is reported as such", async () => {
    const h = harness(() => ({}), { launchFails: true });

    const result = await h.manager.authenticate(START, h.confirm());

    expect(result).toMatchObject({ status: "error", code: "launch-failed" });
    expect(await profileExists(h.launches[0]!.profileDir)).toBe(false);
  });
});
