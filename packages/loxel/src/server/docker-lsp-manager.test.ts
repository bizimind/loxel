import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerWebSocket } from "bun";

import { DockerLspManager } from "./docker-lsp-manager";

// A stand-in for docker-language-server: answers `initialize` with its capabilities, then reports
// what it was started with and asks for its configuration, as the real one does on `didOpen`.
const FAKE_SERVER = `
let buf = Buffer.alloc(0);
const write = (msg) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }));
  process.stdout.write("Content-Length: " + body.byteLength + "\\r\\n\\r\\n");
  process.stdout.write(body);
};
for await (const chunk of process.stdin) {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const end = buf.indexOf("\\r\\n\\r\\n");
    if (end < 0) break;
    const length = Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0, end).toString())[1]);
    if (buf.byteLength < end + 4 + length) break;
    const msg = JSON.parse(buf.subarray(end + 4, end + 4 + length).toString());
    buf = buf.subarray(end + 4 + length);
    if (msg.method === "initialize") {
      write({
        id: msg.id,
        result: { capabilities: { hoverProvider: true, inlayHintProvider: {} } },
      });
      const { HTTP_PROXY, HTTPS_PROXY, NO_PROXY, no_proxy } = process.env;
      write({
        method: "test/started",
        params: {
          initializationOptions: msg.params.initializationOptions,
          env: { HTTP_PROXY, HTTPS_PROXY, NO_PROXY, no_proxy },
        },
      });
    } else if (msg.method === "textDocument/didOpen") {
      write({
        id: "config",
        method: "workspace/configuration",
        params: { items: [{ section: "docker.lsp" }, { section: "other" }] },
      });
    } else if (msg.id === "config") {
      write({ method: "test/configured", params: { result: msg.result } });
    }
  }
}
`;

interface Frame {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: { capabilities?: Record<string, unknown> };
}

class TestDockerLspManager extends DockerLspManager {
  constructor(private readonly script: string) {
    super();
  }

  protected override resolveBinary(): string {
    return process.execPath;
  }

  protected override spawnArgs(): readonly string[] {
    return [this.script];
  }
}

let wt: string | undefined;
let manager: DockerLspManager | undefined;

afterEach(async () => {
  manager?.destroy();
  manager = undefined;
  if (wt) await rm(wt, { recursive: true, force: true });
  wt = undefined;
});

test("keeps the server from reaching Docker's services", async () => {
  wt = await realpath(await mkdtemp(join(tmpdir(), "docker-lsp-")));
  const script = join(wt, "fake-server.mjs");
  await writeFile(script, FAKE_SERVER);
  manager = new TestDockerLspManager(script);

  const frames: Frame[] = [];
  const listeners = new Set<() => void>();
  const ws = {
    send: (data: string) => {
      frames.push(JSON.parse(data) as Frame);
      for (const listener of listeners) listener();
      return data.length;
    },
    close: () => {},
  } as unknown as ServerWebSocket<unknown>;
  const frame = (matches: (candidate: Frame) => boolean): Promise<Frame> =>
    new Promise((resolve) => {
      const check = () => {
        const found = frames.find(matches);
        if (!found) return;
        listeners.delete(check);
        resolve(found);
      };
      listeners.add(check);
      check();
    });
  const send = (message: Record<string, unknown>) =>
    manager?.handleMessage(ws, JSON.stringify({ jsonrpc: "2.0", ...message }));

  manager.createSession(ws, wt);
  send({ id: 1, method: "initialize", params: { processId: null, capabilities: {} } });

  // Monaco never asks for inlay hints, whose data the server fetches from Docker Hub.
  const initialized = await frame((candidate) => candidate.id === 1);
  expect(initialized.result?.capabilities).toEqual({ hoverProvider: true });

  const started = await frame((candidate) => candidate.method === "test/started");
  expect(started.params?.initializationOptions).toEqual({
    dockercomposeExperimental: { composeSupport: false },
    telemetry: "off",
  });
  expect(started.params?.env).toEqual({
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
    no_proxy: "",
  });

  send({
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri: "file:///Dockerfile", languageId: "dockerfile", version: 1, text: "" },
    },
  });
  const configured = await frame((candidate) => candidate.method === "test/configured");
  expect(configured.params?.result).toEqual([
    {
      telemetry: "off",
      experimental: {
        vulnerabilityScanning: false,
        scout: {
          criticalHighVulnerabilities: false,
          notPinnedDigest: false,
          recommendedTag: false,
          vulnerabilites: false,
        },
      },
    },
    null,
  ]);
  // Answered by the manager: Monaco's client errors on this request, and the server's defaults
  // would then leave Scout on.
  expect(frames.some((candidate) => candidate.method === "workspace/configuration")).toBe(false);
});
