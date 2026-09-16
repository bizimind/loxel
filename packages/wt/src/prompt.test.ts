import { describe, expect, test } from "bun:test";

import { cancellable, PromptCancelled } from "./prompt.ts";

describe("cancellable", () => {
  test("maps inquirer's SIGINT rejection to PromptCancelled", async () => {
    const sigint = Object.assign(new Error("User force closed the prompt with SIGINT"), {
      name: "ExitPromptError",
    });
    await expect(cancellable(Promise.reject(sigint))).rejects.toBeInstanceOf(PromptCancelled);
  });

  test("passes other rejections and resolutions through", async () => {
    await expect(cancellable(Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await cancellable(Promise.resolve("ok"))).toBe("ok");
  });
});
