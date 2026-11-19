import { describe, expect, test } from "bun:test";

import type { IpcMainEvent, WebContents } from "electron";

import { createPermissionPrompts, createSettingsMirror } from "./permission-prompts";

function fakeHost({ destroyed = false } = {}) {
  const sent: { channel: string; payload: unknown }[] = [];
  const host = {
    isDestroyed: () => destroyed,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
  } as unknown as WebContents;
  return { host, sent };
}

const channels = { request: "test:request", withdrawn: "test:withdrawn" };
const promptsOf = () =>
  createPermissionPrompts<{ guestId: number; host: WebContents; origin: string; asks: string }>(
    channels,
    (id, prompt) => ({ id, webContentsId: prompt.guestId, asks: prompt.asks }),
  );

describe("createPermissionPrompts", () => {
  test("shows each prompt in its window under a new id, and withdraws it there", () => {
    const { host, sent } = fakeHost();
    const prompts = promptsOf();
    const first = prompts.show({ guestId: 7, host, origin: "https://a.example", asks: "x" });
    const second = prompts.show({ guestId: 7, host, origin: "https://a.example", asks: "y" });
    expect(second).not.toBe(first);
    expect(prompts.withdraw(first)?.asks).toBe("x");
    expect(prompts.withdraw(first)).toBeUndefined();
    expect(sent).toEqual([
      { channel: channels.request, payload: { id: first, webContentsId: 7, asks: "x" } },
      { channel: channels.request, payload: { id: second, webContentsId: 7, asks: "y" } },
      { channel: channels.withdrawn, payload: { id: first, webContentsId: 7 } },
    ]);
    expect(prompts.entries().map(([id]) => id)).toEqual([second]);
  });

  test("asks again under a new id, so an answer only covers what the user saw", () => {
    const { host, sent } = fakeHost();
    const prompts = promptsOf();
    const prompt = { guestId: 1, host, origin: "https://a.example", asks: "x" };
    const first = prompts.show(prompt);
    prompt.asks = "x and y";
    const second = prompts.reprompt(first, prompt);
    expect(second).not.toBe(first);
    expect(sent.slice(1).map((m) => m.channel)).toEqual([channels.withdrawn, channels.request]);
    expect(prompts.answered({ sender: host } as IpcMainEvent, first)).toBeUndefined();
    expect(prompts.answered({ sender: host } as IpcMainEvent, second)).toBe(prompt);
  });

  test("takes answers only from the window the prompt was shown in", () => {
    const { host } = fakeHost();
    const other = fakeHost().host;
    const prompts = promptsOf();
    const id = prompts.show({ guestId: 1, host, origin: "https://a.example", asks: "x" });
    expect(prompts.answered({ sender: other } as IpcMainEvent, id)).toBeUndefined();
  });

  test("sends no withdrawal to a window that is gone", () => {
    const { host, sent } = fakeHost({ destroyed: true });
    const prompts = promptsOf();
    const id = prompts.show({ guestId: 1, host, origin: "https://a.example", asks: "x" });
    prompts.withdraw(id);
    expect(sent.map((m) => m.channel)).toEqual([channels.request]);
  });
});

describe("createSettingsMirror", () => {
  test("is loaded once a window sends the settings, not by main's own decisions", async () => {
    const mirror = createSettingsMirror<Record<string, string>>({});
    let loaded = false;
    void mirror.loaded.then(() => {
      loaded = true;
    });
    mirror.apply({ a: "allow" });
    await Promise.resolve();
    expect(mirror.isLoaded()).toBe(false);
    expect(loaded).toBe(false);
    mirror.receive({ b: "block" });
    await mirror.loaded;
    expect(mirror.isLoaded()).toBe(true);
    expect(mirror.get()).toEqual({ b: "block" });
  });
});
