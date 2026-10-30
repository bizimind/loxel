// Worker entry: runs the git commands `git-exec-client.ts` asks for. `Bun.spawn` blocks its calling
// thread for as long as the kernel takes to create the process, which is tens of milliseconds when
// agents are spawning heavily, so spawning here keeps that wait off the server's event loop.
//
// This imports `git-exec` directly rather than through the git-commands barrel so the worker loads
// nothing else. It may be terminated at any time, and anything it loaded (native addons above all)
// would be torn down with it. Nothing here limits concurrency: the callers do, as they did when
// they spawned on the main thread.
import { execGit } from "./git-commands/git-exec";
import type { GitExecMessage, GitExecReply } from "./git-exec-client";

declare const self: Worker;

self.onmessage = async ({ data }: MessageEvent<GitExecMessage>) => {
  const result = await execGit(data.request);
  const reply: GitExecReply = { id: data.id, result };
  self.postMessage(reply, [result.stdout.buffer, result.stderr.buffer]);
};
