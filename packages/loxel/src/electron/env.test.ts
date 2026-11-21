import { describe, expect, test } from "bun:test";

import { LOXEL_OVERRIDE_ENV_VARS } from "../loxel-overrides";
import { launchEnv } from "./env";

/** An environment that sets every override, and a variable a user's shells need. */
const launchedWith = {
  ...Object.fromEntries(LOXEL_OVERRIDE_ENV_VARS.map((name) => [name, "1"])),
  VITE_DEV_SERVER_URL: "http://127.0.0.1:5173/",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
};

describe("launchEnv", () => {
  test("a packaged app ignores the dev, demo and test overrides, and keeps the rest", () => {
    expect(launchEnv(launchedWith, true)).toEqual({ SSH_AUTH_SOCK: "/tmp/agent.sock" });
  });

  test("a dev or demo app from the source tree takes them as they are", () => {
    expect(launchEnv(launchedWith, false)).toEqual(launchedWith);
  });
});
