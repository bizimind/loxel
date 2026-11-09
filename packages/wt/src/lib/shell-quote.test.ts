import { describe, expect, test } from "bun:test";

import { shellArg } from "./shell-quote.ts";

describe("shellArg", () => {
  test("leaves plain words unquoted", () => {
    expect(shellArg("remote.origin.fetch")).toBe("remote.origin.fetch");
    expect(shellArg("/tmp/a-b/c.git")).toBe("/tmp/a-b/c.git");
    expect(shellArg("key=value")).toBe("key=value");
  });

  test("quotes globs, spaces, quotes and a leading '='", () => {
    expect(shellArg("+refs/heads/*:refs/remotes/origin/*")).toBe(
      "'+refs/heads/*:refs/remotes/origin/*'",
    );
    expect(shellArg("a b")).toBe("'a b'");
    expect(shellArg("it's")).toBe(`'it'\\''s'`);
    expect(shellArg("=foo")).toBe("'=foo'");
    expect(shellArg("")).toBe("''");
  });
});
