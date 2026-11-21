import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bearer, newSessionSecret } from "./app-session";
import { DEV_ACCESS_PARAM, authorizeProxyRequest, devAccessFor, newDevAccess } from "./dev-proxy";
import { writeSessionToken } from "./server/session-token";

const BASE = "http://127.0.0.1:5173/";

/** What the middleware answered: a redirect with a cookie, a refusal, or passing it on. */
function visit(access: ReturnType<typeof newDevAccess>, url: string) {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    end: () => {},
  };
  let passedOn = false;
  access.middleware({ url } as IncomingMessage, res as unknown as ServerResponse, () => {
    passedOn = true;
  });
  return { status: res.statusCode, headers, passedOn };
}

/** The cookie the access link sets, as a browser sends it back. */
function cookieFrom(access: ReturnType<typeof newDevAccess>): string {
  const link = new URL(access.link(BASE));
  const setCookie = visit(access, `${link.pathname}${link.search}`).headers["Set-Cookie"] ?? "";
  return setCookie.split(";")[0]!;
}

describe("the dev server's access link", () => {
  test("sets a private cookie and redirects to the page without the token", () => {
    const access = newDevAccess(5173);
    const link = new URL(access.link(`${BASE}?keep=1`));
    const answer = visit(access, `${link.pathname}${link.search}`);
    expect(answer.status).toBe(302);
    expect(answer.headers.Location).toBe("/?keep=1");
    expect(answer.headers["Set-Cookie"]).toMatch(
      new RegExp(`^${DEV_ACCESS_PARAM}-5173=[A-Za-z0-9_-]+; Path=/; HttpOnly; SameSite=Strict$`),
    );
  });

  test("refuses a token from another run, and leaves every other request alone", () => {
    const access = newDevAccess(5173);
    expect(visit(access, `/?${DEV_ACCESS_PARAM}=other`).status).toBe(403);
    expect(visit(access, "/src/main.tsx").passedOn).toBe(true);
  });

  test("admits only a browser holding this run's cookie", () => {
    const access = newDevAccess(5173);
    const cookie = cookieFrom(access);
    expect(access.admits(`other=1; ${cookie}`)).toBe(true);
    expect(access.admits(undefined)).toBe(false);
    expect(access.admits(cookieFrom(newDevAccess(5173)))).toBe(false);
    // Another dev server's port has its own cookie.
    expect(access.admits(cookie.replace("-5173=", "-5183="))).toBe(false);
  });
});

describe("authorizeProxyRequest", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "loxel-dev-proxy-"));
  const secret = newSessionSecret();
  writeSessionToken(stateDir, secret);
  afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

  /** The headers the proxy forwards for a request with `headers`, which it starts as a copy of. */
  function forwarded(headers: Record<string, string>, access = newDevAccess(5173)) {
    const sent: Record<string, string> = { ...headers };
    const proxyReq = {
      getHeader: (name: string) => sent[name.toLowerCase()],
      setHeader: (name: string, value: string) => {
        sent[name.toLowerCase()] = value;
      },
      removeHeader: (name: string) => {
        delete sent[name.toLowerCase()];
      },
    };
    authorizeProxyRequest(proxyReq, { headers } as unknown as IncomingMessage, access, stateDir);
    return sent;
  }

  test("adds the server's secret for the app's page in the browser that opened the link", () => {
    const access = newDevAccess(5173);
    const cookie = cookieFrom(access);
    for (const site of ["same-origin", "none"]) {
      const sent = forwarded({ cookie, "sec-fetch-site": site }, access);
      expect(sent.authorization).toBe(bearer(secret));
    }
  });

  test("keeps the access cookie from the server, and passes the others on", () => {
    const access = newDevAccess(5173);
    const cookie = cookieFrom(access);
    expect(forwarded({ cookie, "sec-fetch-site": "same-origin" }, access).cookie).toBeUndefined();
    const both = forwarded({ cookie: `a=1; ${cookie}; b=2`, "sec-fetch-site": "none" }, access);
    expect(both.cookie).toBe("a=1; b=2");
  });

  test("adds nothing for a page on another port of the host, though it sends the cookie", () => {
    const access = newDevAccess(5173);
    const cookie = cookieFrom(access);
    for (const site of ["same-site", "cross-site"]) {
      expect(forwarded({ cookie, "sec-fetch-site": site }, access).authorization).toBeUndefined();
    }
    expect(forwarded({ cookie }, access).authorization).toBeUndefined();
  });

  test("adds nothing for any other client", () => {
    expect(forwarded({ "sec-fetch-site": "none" }).authorization).toBeUndefined();
    const unrelated = { cookie: "unrelated=1", "sec-fetch-site": "none" };
    expect(forwarded(unrelated).authorization).toBeUndefined();
  });

  test("refuses a cookie of the token's length in other characters, without failing", () => {
    const access = newDevAccess(5173);
    const value = "\u00e9".repeat(cookieFrom(access).split("=")[1]!.length);
    const sent = forwarded({ cookie: `${access.cookieName}=${value}`, "sec-fetch-site": "none" });
    expect(sent.authorization).toBeUndefined();
  });

  test("forwards a client's own secret as it is", () => {
    expect(forwarded({ authorization: "Bearer own" }).authorization).toBe("Bearer own");
  });

  test("adds nothing under the dev app, whose main process sends the secret", () => {
    const proxyReq = {
      getHeader: () => undefined,
      setHeader: () => expect.unreachable(),
      removeHeader: () => expect.unreachable(),
    };
    authorizeProxyRequest(proxyReq, { headers: {} } as IncomingMessage, null, stateDir);
  });
});

describe("devAccessFor", () => {
  test("keeps a port's token for the process's life, as Vite restarts on a config change", () => {
    const first = devAccessFor(5199);
    const again = devAccessFor(5199);
    expect(again.link(BASE)).toBe(first.link(BASE));
    expect(devAccessFor(5198).link(BASE)).not.toBe(first.link(BASE));
  });
});
