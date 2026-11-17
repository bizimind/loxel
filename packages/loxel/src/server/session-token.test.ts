import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { newSessionSecret, readSessionToken, sessionTokenPath } from "@/app-session";

import { removeSessionToken, writeSessionToken } from "./session-token";

let stateDir: string;
const freshStateDir = () => (stateDir = mkdtempSync(path.join(tmpdir(), "loxel-token-")));

afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("the session token file", () => {
  test("holds the secret, readable only by this user, in a private directory", () => {
    freshStateDir();
    const secret = newSessionSecret();
    writeSessionToken(stateDir, secret);
    expect(readSessionToken(stateDir)).toBe(secret);
    expect(statSync(sessionTokenPath(stateDir)).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(sessionTokenPath(stateDir))).mode & 0o777).toBe(0o700);
  });

  test("is removed by the server that wrote it, but not once a newer one replaced it", () => {
    freshStateDir();
    const older = newSessionSecret();
    const newer = newSessionSecret();
    writeSessionToken(stateDir, older);
    writeSessionToken(stateDir, newer);
    removeSessionToken(stateDir, older);
    expect(readSessionToken(stateDir)).toBe(newer);
    removeSessionToken(stateDir, newer);
    expect(readSessionToken(stateDir)).toBeNull();
  });
});
