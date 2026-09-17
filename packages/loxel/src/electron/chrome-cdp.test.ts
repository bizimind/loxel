import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { ChromeCdpPipe } from "./chrome-cdp";

function createPipe() {
  const commands = new PassThrough();
  const responses = new PassThrough();
  const pipe = new ChromeCdpPipe(commands, responses);
  return { commands, responses, pipe };
}

function readCommand(commands: PassThrough): Record<string, unknown> {
  const chunk = commands.read();
  if (!chunk) throw new Error("Expected a CDP command");
  const frame = chunk.toString("utf8");
  return JSON.parse(frame.endsWith("\0") ? frame.slice(0, -1) : frame) as Record<string, unknown>;
}

describe("ChromeCdpPipe", () => {
  test("frames commands with NUL and correlates fragmented responses", async () => {
    const { commands, responses, pipe } = createPipe();
    const resultPromise = pipe.send<{ product: string }>("Browser.getVersion");
    const command = readCommand(commands);

    expect(command).toEqual({ id: 1, method: "Browser.getVersion", params: {} });
    responses.write('{"id":1,"result":{"prod');
    responses.write('uct":"Chrome"}}\0');

    await expect(resultPromise).resolves.toEqual({ product: "Chrome" });
    pipe.close();
  });

  test("handles batched and out-of-order responses", async () => {
    const { commands, responses, pipe } = createPipe();
    const first = pipe.send<{ value: string }>("First");
    const second = pipe.send<{ value: string }>("Second", {}, { sessionId: "page" });
    const chunk = commands.read();
    if (!chunk) throw new Error("Expected CDP commands");
    const [firstFrame, secondFrame] = chunk.toString("utf8").split("\0");
    const firstCommand = JSON.parse(firstFrame!) as Record<string, unknown>;
    const secondCommand = JSON.parse(secondFrame!) as Record<string, unknown>;

    expect(firstCommand.id).toBe(1);
    expect(secondCommand).toEqual({ id: 2, method: "Second", params: {}, sessionId: "page" });
    responses.write('{"id":2,"result":{"value":"second"}}\0{"id":1,"result":{"value":"first"}}\0');

    await expect(first).resolves.toEqual({ value: "first" });
    await expect(second).resolves.toEqual({ value: "second" });
    pipe.close();
  });

  test("ignores events and rejects protocol errors", async () => {
    const { commands, responses, pipe } = createPipe();
    const resultPromise = pipe.send("Network.getCookies");
    readCommand(commands);

    responses.write('{"method":"Network.loadingFinished","params":{}}\0');
    responses.write('{"id":1,"error":{"message":"Not attached"}}\0');

    await expect(resultPromise).rejects.toThrow("Not attached");
    pipe.close();
  });

  test("rejects pending commands on malformed JSON", async () => {
    const { commands, responses, pipe } = createPipe();
    const resultPromise = pipe.send("Browser.getVersion");
    readCommand(commands);
    responses.write("not-json\0");

    await expect(resultPromise).rejects.toThrow("invalid debugging response");
    expect(pipe.isClosed).toBe(true);
  });

  test("rejects commands when the response stream closes", async () => {
    const { commands, responses, pipe } = createPipe();
    const resultPromise = pipe.send("Browser.getVersion");
    readCommand(commands);
    responses.end();

    await expect(resultPromise).rejects.toThrow("connection closed");
    expect(pipe.isClosed).toBe(true);
  });

  test("times out unanswered commands", async () => {
    const { commands, pipe } = createPipe();
    const resultPromise = pipe.send("Browser.getVersion", {}, { timeoutMs: 5 });
    readCommand(commands);

    await expect(resultPromise).rejects.toThrow("command timed out");
    pipe.close();
  });
});
