import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { PassThrough } from "node:stream";

import { bearer, newSessionSecret } from "../app-session";
import { encodeServerMessage } from "../parent-channel-protocol";
import {
  carriesSecret,
  followServerChannel,
  serverAuthorization,
  serverHasListened,
  whenServerListening,
} from "./app-server";

const APP = "http://127.0.0.1:7433";
const fromWindow = (url: string, frameOrigin: string | undefined = APP) =>
  carriesSecret({ url, contentsType: "window", frameOrigin }, APP);

describe("carriesSecret", () => {
  test("the app's own requests to its server's API and sockets", () => {
    expect(fromWindow(`${APP}/api/projects`)).toBe(true);
    expect(fromWindow("ws://127.0.0.1:7433/ws")).toBe(true);
    expect(fromWindow("ws://127.0.0.1:7433/ws/ts-lsp?wt=/x")).toBe(true);
    // A worker's request has no frame.
    expect(fromWindow(`${APP}/api/log`, undefined)).toBe(true);
    expect(carriesSecret({ url: `${APP}/api/log` }, APP)).toBe(true);
  });

  test("never another origin, another port on the same host included", () => {
    expect(fromWindow("http://127.0.0.1:3000/api/projects")).toBe(false);
    expect(fromWindow("ws://127.0.0.1:3000/ws")).toBe(false);
    expect(fromWindow("http://localhost:7433/api/projects")).toBe(false);
    expect(fromWindow("https://127.0.0.1:7433/api/projects")).toBe(false);
  });

  test("not the renderer's static files", () => {
    expect(fromWindow(`${APP}/`)).toBe(false);
    expect(fromWindow(`${APP}/assets/index.js`)).toBe(false);
  });

  test("not a webview's, nor a frame from another origin", () => {
    const url = `${APP}/api/projects`;
    expect(carriesSecret({ url, contentsType: "webview", frameOrigin: APP }, APP)).toBe(false);
    expect(fromWindow(url, "https://example.com")).toBe(false);
    expect(fromWindow(url, "null")).toBe(false);
  });

  test("a frame's navigation by what embeds it, as the media viewer's opaque SVG frame", () => {
    const frame = `${APP}/api/media-frame?path=/x.svg`;
    const navigation = (parentOrigin: string) =>
      carriesSecret(
        {
          url: frame,
          contentsType: "window",
          frameOrigin: "null",
          resourceType: "subFrame",
          parentOrigin,
        },
        APP,
      );
    expect(navigation(APP)).toBe(true);
    expect(navigation("null")).toBe(false);
    expect(navigation("https://example.com")).toBe(false);
    // What the frame's own scripts request is not a navigation.
    const fetched = { url: `${APP}/api/projects`, contentsType: "window", frameOrigin: "null" };
    expect(carriesSecret({ ...fetched, resourceType: "xhr", parentOrigin: APP }, APP)).toBe(false);
  });

  test("the Vite dev server's origin in dev", () => {
    const vite = "http://127.0.0.1:5173";
    const req = (url: string) => ({ url, contentsType: "window", frameOrigin: vite });
    expect(carriesSecret(req(`${vite}/api/projects`), vite)).toBe(true);
    expect(carriesSecret(req("ws://127.0.0.1:5173/ws"), vite)).toBe(true);
    expect(carriesSecret(req(`${APP}/api/projects`), vite)).toBe(false);
  });
});

/** A server main started, as its channel shows it: what it says, and its exit. */
function startedServer() {
  const channel = new PassThrough();
  const secret = newSessionSecret();
  const exited = Promise.withResolvers<number | null>();
  const started = followServerChannel(channel, secret, exited.promise);
  return {
    secret,
    started,
    channel,
    say: (line: string) => channel.write(line),
    listen: () => channel.write(encodeServerMessage({ type: "listening" })),
    exit: async (code: number | null = 1) => {
      exited.resolve(code);
      channel.destroy();
      await once(channel, "close");
    },
  };
}

describe("the session secret of the server main started", () => {
  test("is sent only once that server says it is listening, and only until it exits", async () => {
    const server = startedServer();
    expect(serverAuthorization()).toEqual({});
    expect(serverHasListened()).toBe(false);
    server.say("not a message\n");
    server.listen();
    await server.started;
    expect(serverAuthorization()).toEqual({ Authorization: bearer(server.secret) });
    expect(serverHasListened()).toBe(true);
    await server.exit();
    expect(serverAuthorization()).toEqual({});
  });

  test("a server that exits before it is listening failed to start, and says how", async () => {
    const server = startedServer();
    await server.exit(1);
    await expect(server.started).rejects.toThrow("stopped before it was ready (exit code 1)");
    expect(serverAuthorization()).toEqual({});
  });

  test("a server main stops before it is listening is no failure: the app is quitting", async () => {
    const server = startedServer();
    let settled = false;
    server.started.then(
      () => (settled = true),
      () => (settled = true),
    );
    server.channel.end();
    // Its exit and the channel's close have been handled by the time this resolves.
    await server.exit(0);
    expect(settled).toBe(false);
  });

  test("a restarted server has a secret of its own, which the windows move to", async () => {
    const first = startedServer();
    first.listen();
    await first.started;
    await first.exit();

    const restarted = startedServer();
    expect(restarted.secret).not.toBe(first.secret);
    const ready = whenServerListening();
    restarted.listen();
    await ready;
    expect(serverAuthorization()).toEqual({ Authorization: bearer(restarted.secret) });
    await restarted.exit();
  });

  test("an earlier server's exit leaves a later server's secret alone", async () => {
    const earlier = startedServer();
    earlier.listen();
    await earlier.started;
    const later = startedServer();
    later.listen();
    await later.started;
    await earlier.exit();
    expect(serverAuthorization()).toEqual({ Authorization: bearer(later.secret) });
    await later.exit();
  });
});
