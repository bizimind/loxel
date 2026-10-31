import { describe, expect, test } from "bun:test";

import { commitToolchainEnvChange, type SpawnEnv } from "./toolchain-env-contributor";

function commit(env: SpawnEnv, change: (changed: SpawnEnv) => void): SpawnEnv {
  const changed = { ...env };
  change(changed);
  commitToolchainEnvChange(env, changed);
  return env;
}

describe("commitToolchainEnvChange", () => {
  test("takes the change whole: set, changed and removed variables", () => {
    const env = commit({ PATH: "/usr/bin", GONE: "1", KEPT: "1" }, (changed) => {
      changed.PATH = `/wt/bin:${changed.PATH}`;
      changed.ADDED = "1";
      delete changed.GONE;
    });
    expect(env).toEqual({ PATH: "/wt/bin:/usr/bin", ADDED: "1", KEPT: "1" });
  });

  test.each(['/wt-"name/bin', "/wt-$name/bin", "/wt-`name`/bin", "/wt-\\name/bin"])(
    "refuses the whole change when PATH gains %s",
    (dir) => {
      const env = commit({ PATH: "/usr/bin", GONE: "1" }, (changed) => {
        changed.PATH = `${dir}:${changed.PATH}`;
        changed.ADDED = "1";
        delete changed.GONE;
      });
      expect(env).toEqual({ PATH: "/usr/bin", GONE: "1" });
    },
  );

  test("refuses moving such an entry forward", () => {
    const env = commit({ PATH: "/usr/bin:/wt-$name/bin" }, (changed) => {
      changed.PATH = "/wt-$name/bin:/usr/bin";
    });
    expect(env.PATH).toBe("/usr/bin:/wt-$name/bin");
  });

  test("refuses moving such an entry ahead of another while adding one in front", () => {
    const env = commit({ PATH: "/usr/bin:/wt-$name/bin" }, (changed) => {
      changed.PATH = "/new/bin:/wt-$name/bin:/usr/bin";
    });
    expect(env.PATH).toBe("/usr/bin:/wt-$name/bin");
  });

  test("does not count a duplicate removed ahead of an inherited entry as moving it", () => {
    const env = commit({ PATH: "/wt/bin:/usr/bin:/wt/bin:/home/$me/bin" }, (changed) => {
      changed.PATH = "/wt/bin:/usr/bin:/home/$me/bin";
    });
    expect(env.PATH).toBe("/wt/bin:/usr/bin:/home/$me/bin");
  });

  test("does not hold an inherited entry against a contribution", () => {
    const env = commit({ PATH: "/usr/bin:/home/$me/bin" }, (changed) => {
      changed.PATH = `/wt/bin:${changed.PATH}`;
    });
    expect(env.PATH).toBe("/wt/bin:/usr/bin:/home/$me/bin");
  });
});
