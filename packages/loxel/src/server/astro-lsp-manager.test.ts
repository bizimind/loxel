import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerWebSocket } from "bun";

import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";

// Before the imports that read it: trust is stored in the state directory.
const stateDir = await mkdtemp(join(tmpdir(), "astro-lsp-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { ASTRO_REPO_TRUST_RESTRICTION, AstroLspManager } = await import("./astro-lsp-manager");
const { getRepoTrustStatus, setRepoTrusted } = await import("./repo-trust");

/** Counts the times a server would have been started. */
class CountingAstroLspManager extends AstroLspManager {
  starts = 0;

  protected override resolveBundledBinary(): string | null {
    this.starts++;
    return null;
  }
}

let wt: string | undefined;
let manager: CountingAstroLspManager | undefined;

afterEach(async () => {
  await manager?.destroy();
  manager = undefined;
  if (wt) await rm(wt, { recursive: true, force: true });
  wt = undefined;
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

test("answers without a server until the repository is trusted, then reconnects", async () => {
  wt = await realpath(await mkdtemp(join(tmpdir(), "astro-lsp-")));
  const sent: unknown[] = [];
  let closeCode: (code: number) => void = () => {};
  const closed = new Promise<number>((resolve) => {
    closeCode = resolve;
  });
  const ws = {
    send: (data: string) => {
      sent.push(JSON.parse(data));
      return data.length;
    },
    close: (code: number) => closeCode(code),
  } as unknown as ServerWebSocket<unknown>;
  const testManager = new CountingAstroLspManager();
  manager = testManager;

  testManager.createSession(ws, wt);
  testManager.handleMessage(
    ws,
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } }),
  );
  testManager.handleMessage(
    ws,
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "textDocument/hover" }),
  );
  expect(sent).toEqual([
    {
      jsonrpc: "2.0",
      id: 1,
      result: { capabilities: { textDocumentSync: { openClose: true, change: 0 } } },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32601, message: "Unhandled method textDocument/hover" },
    },
  ]);
  expect(testManager.starts).toBe(0);
  expect(getRepoTrustStatus(wt).restrictions).toEqual([ASTRO_REPO_TRUST_RESTRICTION]);

  setRepoTrusted(wt, true);
  expect(await closed).toBe(LSP_RESTART_CLOSE_CODE);
});
