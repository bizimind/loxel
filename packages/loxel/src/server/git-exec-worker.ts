// Worker entry: runs the git commands `git-exec-client.ts` asks for. `Bun.spawn` blocks its calling
// thread for as long as the kernel takes to create the process, which is tens of milliseconds when
// agents are spawning heavily, so spawning here keeps that wait off the server's event loop.
//
// This imports `git-exec` directly rather than through the git-commands barrel so the worker loads
// nothing else. It may be terminated at any time, and anything it loaded (native addons above all)
// would be torn down with it. Nothing here limits concurrency: the callers do, as they did when
// they spawned on the main thread.
import { execGit, type GitExecResult } from "./git-commands/git-exec";
import type { GitExecMessage, GitExecReply } from "./git-exec-client";

declare const self: Worker;

function failure(error: unknown): GitExecResult {
  return {
    exitCode: 1,
    stdout: new Uint8Array(),
    stderr: new TextEncoder().encode(`${error instanceof Error ? error.message : String(error)}\n`),
    spawnBlockMs: 0,
    wallMs: 0,
  };
}

// A throw here would kill the worker and fail every request in flight, so it stays with its request.
self.onmessage = async ({ data: { id, request } }: MessageEvent<GitExecMessage>) => {
  try {
    const result = await execGit(request);
    const reply: GitExecReply = { id, result };
    self.postMessage(reply, [result.stdout.buffer, result.stderr.buffer]);
  } catch (error) {
    const reply: GitExecReply = { id, result: failure(error) };
    self.postMessage(reply);
  }
};
