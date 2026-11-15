import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

const originalClient = await import("@/api/client");
const putStore = jest.fn(async () => {});
mock.module("@/api/client", () => ({ ...originalClient, putStore }));

const { createServerStorage } = await import("./server-storage");

describe("createServerStorage", () => {
  beforeEach(() => {
    putStore.mockClear();
  });

  test("flushes a pending write with keepalive when the window closes", () => {
    const storage = createServerStorage("test-flush");
    storage.setItem("name", "first");
    storage.setItem("name", "last");
    expect(putStore).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("pagehide"));
    expect(putStore).toHaveBeenCalledTimes(1);
    expect(putStore).toHaveBeenCalledWith("test-flush", "last", expect.any(String), {
      keepalive: true,
    });
  });

  test("writes nothing on close when no write is pending", () => {
    createServerStorage("test-idle");
    window.dispatchEvent(new Event("pagehide"));
    expect(putStore).not.toHaveBeenCalled();
  });

  test("does not write a flushed value twice", () => {
    const storage = createServerStorage("test-once");
    storage.setItem("name", "value");
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pagehide"));
    expect(putStore).toHaveBeenCalledTimes(1);
  });
});
