import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync } from "node:fs";
import { createInterface } from "node:readline";
import { Duplex, PassThrough } from "node:stream";

import { newSessionSecret } from "@/app-session";
import type { ShutdownTerminals } from "@/parent-channel-protocol";
import {
  PARENT_CHANNEL_FD,
  encodeParentMessage,
  parseServerMessage,
} from "@/parent-channel-protocol";

import { listenToParent } from "./parent-channel";

/** A channel over a pipe the test writes to, and what its listener got. */
function openChannel() {
  const input = new PassThrough();
  const events: (ShutdownTerminals | "closed" | { session: string; windowIds: string[] })[] = [];
  let onEvent = () => {};
  /** Resolves once the listener has had `count` events. */
  const eventsReached = (count: number) =>
    new Promise<void>((resolve) => {
      onEvent = () => {
        if (events.length >= count) resolve();
      };
      onEvent();
    });
  listenToParent(input, {
    session: (secret, windowIds) => {
      events.push({ session: secret, windowIds });
      onEvent();
    },
    shutdown: (terminals) => {
      events.push(terminals);
      onEvent();
    },
    closed: () => {
      events.push("closed");
      onEvent();
    },
  });
  return { input, events, eventsReached };
}

describe("listenToParent", () => {
  test("delivers the app's shutdown, then the channel closing", async () => {
    const { input, events, eventsReached } = openChannel();
    input.write(encodeParentMessage({ type: "shutdown", terminals: "keep" }));
    input.end();
    await eventsReached(2);
    expect(events).toEqual(["keep", "closed"]);
  });

  test("delivers the app's session secret and windows, then its shutdown", async () => {
    const { input, events, eventsReached } = openChannel();
    const secret = newSessionSecret();
    const windowIds = [crypto.randomUUID()];
    input.write(encodeParentMessage({ type: "session", secret, windowIds }));
    input.end(encodeParentMessage({ type: "shutdown", terminals: "end" }));
    await eventsReached(3);
    expect(events).toEqual([{ session: secret, windowIds }, "end", "closed"]);
  });

  test("ignores a session message whose secret is not one", async () => {
    const { input, events, eventsReached } = openChannel();
    input.end(`${JSON.stringify({ type: "session", secret: "short", windowIds: [] })}\n`);
    await eventsReached(1);
    expect(events).toEqual(["closed"]);
  });

  test("ignores a session message with a window ID that is not one", async () => {
    const { input, events, eventsReached } = openChannel();
    const secret = newSessionSecret();
    input.end(`${JSON.stringify({ type: "session", secret, windowIds: ["%"] })}\n`);
    await eventsReached(1);
    expect(events).toEqual(["closed"]);
  });

  test("the channel closing without a message means the app is gone", async () => {
    const { input, events, eventsReached } = openChannel();
    input.end();
    await eventsReached(1);
    expect(events).toEqual(["closed"]);
  });

  test("the channel failing means the app is gone, said once", async () => {
    const { input, events, eventsReached } = openChannel();
    input.destroy(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    await eventsReached(1);
    // Whatever follows the failure (the stream's close) adds nothing.
    if (!input.closed) await once(input, "close");
    expect(events).toEqual(["closed"]);
  });

  test("ignores lines that are not messages", async () => {
    const { input, events, eventsReached } = openChannel();
    input.write("not json\n");
    input.write(`${JSON.stringify({ type: "shutdown", terminals: "later" })}\n`);
    input.end(encodeParentMessage({ type: "shutdown", terminals: "end" }));
    await eventsReached(2);
    expect(events).toEqual(["end", "closed"]);
  });
});

/**
 * The channel is not stdin because the server's children get its stdin; this pins that they never
 * get the channel's descriptor either, however the server starts them (git commands, formatters,
 * the detached terminal host). A Bun upgrade that changed it would hand the channel to git hooks.
 */
describe("the channel's descriptor", () => {
  test("is open in the server and never reaches a child it starts", async () => {
    const probe = `[ -e /dev/fd/${PARENT_CHANNEL_FD} ] && echo open || echo closed`;
    const script = `
      import { fstatSync } from "node:fs";
      const probe = ${JSON.stringify(probe)};
      const read = async (proc) => (await new Response(proc.stdout).text()).trim();
      console.log(JSON.stringify({
        // The probe sees a descriptor that is open.
        probe: await read(Bun.spawn(["sh", "-c", "exec ${PARENT_CHANNEL_FD}</dev/null; " + probe], { stdout: "pipe" })),
        server: fstatSync(${PARENT_CHANNEL_FD}).isSocket() || fstatSync(${PARENT_CHANNEL_FD}).isFIFO(),
        shell: (await Bun.$\`sh -c \${probe}\`.text()).trim(),
        spawnInheritingStdin: await read(Bun.spawn(["sh", "-c", probe], { stdin: "inherit", stdout: "pipe" })),
        detached: await read(Bun.spawn(["sh", "-c", probe], { detached: true, stdout: "pipe" })),
      }));
    `;
    const server = Bun.spawn(["bun", "-e", script], {
      stdio: ["ignore", "pipe", "ignore", "pipe"],
    });
    const channelFd = server.stdio[PARENT_CHANNEL_FD];
    const output = await new Response(server.stdout).text();
    expect(await server.exited).toBe(0);
    if (typeof channelFd === "number") closeSync(channelFd);
    expect(JSON.parse(output.trim())).toEqual({
      probe: "open",
      server: true,
      shell: "closed",
      spawnInheritingStdin: "closed",
      detached: "closed",
    });
  });
});

/** The channel goes both ways, as Electron main spawns the server: a server answers on it. */
describe("tellParent", () => {
  test("reaches the app on the channel it reads the app's messages from", async () => {
    const script = `
      import { listenToParent, parentChannelInput, tellParent } from ${JSON.stringify(`${import.meta.dir}/parent-channel.ts`)};
      listenToParent(parentChannelInput(), {
        session: () => tellParent({ type: "listening" }),
        shutdown: () => {},
        closed: () => process.exit(0),
      });
    `;
    const server = spawn("bun", ["-e", script], { stdio: ["ignore", "ignore", "inherit", "pipe"] });
    const channel = server.stdio[PARENT_CHANNEL_FD];
    if (!(channel instanceof Duplex)) throw new Error("The channel is not a socket pair");
    const secret = newSessionSecret();
    channel.write(encodeParentMessage({ type: "session", secret, windowIds: [] }));
    const [line] = (await once(createInterface({ input: channel }), "line")) as [string];
    expect(parseServerMessage(line)).toEqual({ type: "listening" });
    channel.end();
    const [code] = (await once(server, "exit")) as [number];
    expect(code).toBe(0);
  });
});
