import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpenInApps } from "@/api/open-in-model";

import { handleOpenInRequest } from "./open-in-routes";
import type { OpenInRouteContext } from "./open-in-routes";

let root: string;
let file: string;
let folder: string;
let app: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "open-in-routes-"));
  file = join(root, "notes.md");
  folder = join(root, "docs");
  app = join(root, "Editor.app");
  await Bun.write(file, "# notes");
  await mkdir(folder);
  await mkdir(app);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const FOLDER_APPS: OpenInApps["apps"] = [
  { path: "/System/Applications/Utilities/Terminal.app", name: "Terminal", group: "terminal" },
  { path: "/Applications/Zed.app", name: "Zed", group: "editor" },
];

const APPS: OpenInApps = {
  defaultApp: { path: "/Applications/TextEdit.app", name: "TextEdit" },
  apps: [{ path: "/Applications/Xcode.app", name: "Xcode" }],
};

function createContext() {
  const openCalls: string[][] = [];
  const ctx: OpenInRouteContext = {
    isManagedPath: (path) => path.startsWith(`${root}/`),
    launchServices: {
      appsForFile: async () => APPS,
      appIcon: async () => new Uint8Array([137, 80, 78, 71]),
      hasListedApp: (appPath) => appPath === app,
    },
    folderApps: async () => FOLDER_APPS,
    runOpen: async (args) => {
      openCalls.push(args);
    },
  };
  return { ctx, openCalls };
}

function get(path: string): Request {
  return new Request(`http://localhost${path}`);
}

function post(path: string, body: unknown, contentType = "application/json"): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response | null) {
  return { status: response?.status, body: await response?.json() };
}

describe("handleOpenInRequest", () => {
  test("ignores unrelated routes", async () => {
    const { ctx } = createContext();
    expect(await handleOpenInRequest(get("/api/open-in/unknown"), ctx)).toBeNull();
  });

  describe("GET /api/open-in/apps", () => {
    test("lists apps for a managed file", async () => {
      const { ctx } = createContext();
      const response = await handleOpenInRequest(
        get(`/api/open-in/apps?path=${encodeURIComponent(file)}`),
        ctx,
      );
      expect(await response?.json()).toEqual(APPS);
    });

    test.each([
      ["missing path", "", 400],
      ["relative path", "notes.md", 400],
      ["non-normalized path", "/tmp/../etc/passwd", 400],
      ["path outside open projects", "/etc/hosts", 404],
    ])("rejects %s", async (_name, path, status) => {
      const { ctx } = createContext();
      const response = await handleOpenInRequest(
        get(`/api/open-in/apps?path=${encodeURIComponent(path)}`),
        ctx,
      );
      expect(response?.status).toBe(status);
    });

    test("rejects missing files", async () => {
      const { ctx } = createContext();
      const missing = await handleOpenInRequest(
        get(`/api/open-in/apps?path=${encodeURIComponent(join(root, "gone.md"))}`),
        ctx,
      );
      expect(missing?.status).toBe(404);
    });

    test("lists the curated folder apps for a folder", async () => {
      const { ctx } = createContext();
      const response = await handleOpenInRequest(
        get(`/api/open-in/apps?path=${encodeURIComponent(folder)}`),
        ctx,
      );
      expect(await response?.json()).toEqual({ defaultApp: null, apps: FOLDER_APPS });
    });
  });

  describe("GET /api/open-in/app-icon", () => {
    test("returns the PNG for an app bundle", async () => {
      const { ctx } = createContext();
      const response = await handleOpenInRequest(
        get(`/api/open-in/app-icon?app=${encodeURIComponent(app)}`),
        ctx,
      );
      expect(response?.headers.get("Content-Type")).toBe("image/png");
      expect(new Uint8Array(await response!.arrayBuffer())).toEqual(
        new Uint8Array([137, 80, 78, 71]),
      );
    });

    test("rejects invalid paths and apps that were never listed", async () => {
      const { ctx } = createContext();
      for (const [path, status] of [
        [file, 400],
        ["Editor.app", 400],
        [join(root, "Missing.app"), 404],
        ["/System/Applications/Calculator.app", 404],
      ] as const) {
        const response = await handleOpenInRequest(
          get(`/api/open-in/app-icon?app=${encodeURIComponent(path)}`),
          ctx,
        );
        expect(response?.status).toBe(status);
      }
    });

    test("serves icons of listed folder apps", async () => {
      const { ctx } = createContext();
      const response = await handleOpenInRequest(
        get(`/api/open-in/app-icon?app=${encodeURIComponent(FOLDER_APPS[1]!.path)}`),
        ctx,
      );
      expect(response?.status).toBe(200);
    });
  });

  describe("POST /api/open-in/reveal", () => {
    test("reveals files and folders in Finder", async () => {
      const { ctx, openCalls } = createContext();
      for (const path of [file, folder]) {
        const response = await handleOpenInRequest(post("/api/open-in/reveal", { path }), ctx);
        expect(response?.status).toBe(200);
      }
      expect(openCalls).toEqual([
        ["-R", file],
        ["-R", folder],
      ]);
    });

    test("rejects bodies not sent as JSON, so other sites can't trigger it", async () => {
      const { ctx, openCalls } = createContext();
      const response = await handleOpenInRequest(
        post("/api/open-in/reveal", { path: file }, "text/plain"),
        ctx,
      );
      expect(response?.status).toBe(400);
      expect(openCalls).toEqual([]);
    });

    test("rejects invalid bodies and unmanaged paths without running open", async () => {
      const { ctx, openCalls } = createContext();
      const invalid = await handleOpenInRequest(post("/api/open-in/reveal", { nope: 1 }), ctx);
      expect(invalid?.status).toBe(400);
      const outside = await handleOpenInRequest(
        post("/api/open-in/reveal", { path: "/etc/hosts" }),
        ctx,
      );
      expect(outside?.status).toBe(404);
      expect(openCalls).toEqual([]);
    });
  });

  describe("POST /api/open-in/open", () => {
    test("opens a file with an offered app", async () => {
      const { ctx, openCalls } = createContext();
      for (const appPath of ["/Applications/TextEdit.app", "/Applications/Xcode.app"]) {
        const response = await handleOpenInRequest(
          post("/api/open-in/open", { path: file, appPath }),
          ctx,
        );
        expect(response?.status).toBe(200);
      }
      expect(openCalls).toEqual([
        ["-a", "/Applications/TextEdit.app", file],
        ["-a", "/Applications/Xcode.app", file],
      ]);
    });

    test("refuses apps macOS does not offer for the file", async () => {
      const { ctx, openCalls } = createContext();
      const response = await handleOpenInRequest(
        post("/api/open-in/open", {
          path: file,
          appPath: "/System/Applications/Utilities/Terminal.app",
        }),
        ctx,
      );
      expect(await errorOf(response)).toEqual({
        status: 400,
        body: { error: "This app cannot open the file" },
      });
      expect(openCalls).toEqual([]);
    });

    test("opens a folder with a curated folder app only", async () => {
      const { ctx, openCalls } = createContext();
      const terminal = await handleOpenInRequest(
        post("/api/open-in/open", { path: folder, appPath: FOLDER_APPS[0]!.path }),
        ctx,
      );
      expect(terminal?.status).toBe(200);
      const fileApp = await handleOpenInRequest(
        post("/api/open-in/open", { path: folder, appPath: "/Applications/Xcode.app" }),
        ctx,
      );
      expect(fileApp?.status).toBe(400);
      expect(openCalls).toEqual([["-a", FOLDER_APPS[0]!.path, folder]]);
    });
  });
});
