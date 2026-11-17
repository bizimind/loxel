import { describe, expect, test } from "bun:test";

import { bearer, newSessionSecret } from "@/app-session";

import {
  type AdmissionRequest,
  type Principal,
  type RequestOriginPolicy,
  checkRequest,
  tcpPrincipal,
} from "./request-origin";

const PORT = 7433;
const prod: RequestOriginPolicy = { port: PORT, viteDevPort: null };
const dev: RequestOriginPolicy = { port: 7434, viteDevPort: 5173 };

// Built from headers rather than `new Request(...)`: the test DOM preload's Request strips the
// `Host` and `Origin` headers these rules inspect.
function request(method: string, headers: Record<string, string> = {}, pathname = "/api/projects") {
  return { method, headers: new Headers({ Host: `127.0.0.1:${PORT}`, ...headers }), pathname };
}

const jsonPost = (headers: Record<string, string> = {}) =>
  request("POST", { "Content-Type": "application/json", ...headers });

const status = (req: AdmissionRequest, policy = prod, principal: Principal = "app") =>
  checkRequest(req, principal, policy)?.status ?? null;

describe("checkRequest: Host", () => {
  test("accepts loopback hosts on the server port only", () => {
    expect(status(request("GET", { Host: `127.0.0.1:${PORT}` }))).toBeNull();
    expect(status(request("GET", { Host: `localhost:${PORT}` }))).toBeNull();
    expect(status(request("GET", { Host: `LOCALHOST:${PORT}` }))).toBeNull();
    expect(status(request("GET", { Host: `[::1]:${PORT}` }))).toBeNull();
  });

  test("rejects any other Host with 400", () => {
    for (const host of [
      `127.0.0.1:${PORT + 1}`,
      "127.0.0.1",
      "evil.example",
      `evil.example:${PORT}`,
      `127.0.0.1.evil.example:${PORT}`,
      `localhost.:${PORT}`,
      `127.0.0.1:${PORT}, 127.0.0.1:${PORT}`,
      "",
    ]) {
      expect(status(request("GET", { Host: host }))).toBe(400);
    }
    expect(status({ method: "GET", headers: new Headers(), pathname: "/" })).toBe(400);
  });

  test("reports the offending host and checks Host before anything else", () => {
    const rejection = checkRequest(
      request("POST", {
        Host: "evil.example",
        Origin: "https://evil.example",
        "Content-Type": "text/plain",
      }),
      "app",
      prod,
    );
    expect(rejection).toMatchObject({ status: 400, details: { host: "evil.example" } });
  });
});

describe("checkRequest: Origin", () => {
  test("allows requests without an Origin header (native clients, same-origin GETs)", () => {
    expect(status(request("GET"))).toBeNull();
    expect(status(jsonPost())).toBeNull();
  });

  test("allows the server's own loopback origins", () => {
    expect(status(request("GET", { Origin: `http://127.0.0.1:${PORT}` }))).toBeNull();
    expect(status(request("GET", { Origin: `http://localhost:${PORT}` }))).toBeNull();
    expect(status(request("GET", { Origin: `HTTP://LOCALHOST:${PORT}` }))).toBeNull();
    expect(status(jsonPost({ Origin: `http://127.0.0.1:${PORT}` }))).toBeNull();
  });

  test("rejects foreign, null, https, and wrong-port origins for any method", () => {
    for (const origin of [
      "https://evil.example",
      "null",
      `https://127.0.0.1:${PORT}`,
      `http://127.0.0.1:${PORT + 1}`,
      `http://127.0.0.1:${PORT}.evil.example`,
      "http://localhost:5173",
    ]) {
      expect(status(request("GET", { Origin: origin }))).toBe(403);
      expect(status(jsonPost({ Origin: origin }))).toBe(403);
    }
    const rejection = checkRequest(jsonPost({ Origin: "https://evil.example" }), "app", prod);
    expect(rejection).toMatchObject({ status: 403, details: { origin: "https://evil.example" } });
  });

  test("checks Origin before the body rules", () => {
    const req = request("POST", { Origin: "https://evil.example", "Content-Type": "text/plain" });
    expect(status(req)).toBe(403);
  });

  test("allows the Vite dev-server origin only when dev origins are enabled", () => {
    const devHost = { Host: "127.0.0.1:7434" };
    expect(status(request("GET", { ...devHost, Origin: "http://localhost:5173" }), dev)).toBeNull();
    expect(status(request("GET", { ...devHost, Origin: "http://127.0.0.1:5173" }), dev)).toBeNull();
    expect(status(request("GET", { ...devHost, Origin: "http://127.0.0.1:7434" }), dev)).toBeNull();
    expect(status(request("GET", { ...devHost, Origin: "http://127.0.0.1:5174" }), dev)).toBe(403);
    expect(status(request("GET", { Origin: "http://127.0.0.1:5173" }), prod)).toBe(403);
  });
});

describe("checkRequest: Sec-Fetch-Site", () => {
  test("admits same-origin and same-site requests", () => {
    expect(status(request("GET", { "Sec-Fetch-Site": "same-origin" }))).toBeNull();
    expect(status(jsonPost({ "Sec-Fetch-Site": "same-origin" }))).toBeNull();
    expect(status(request("GET", { "Sec-Fetch-Site": "none" }))).toBeNull();
  });

  test("admits cross-site top-level document navigations (a link into the app)", () => {
    const navigation = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" };
    expect(status(request("GET", { ...navigation, "Sec-Fetch-Dest": "document" }))).toBeNull();
  });

  test("rejects cross-site fetches, subresource loads and framing of any method", () => {
    const crossSite = { "Sec-Fetch-Site": "cross-site" };
    expect(status(jsonPost(crossSite))).toBe(403);
    expect(status(request("GET", crossSite))).toBe(403);
    for (const [mode, dest] of [
      ["no-cors", "image"],
      ["no-cors", "video"],
      ["cors", "empty"],
      ["navigate", "iframe"],
      ["navigate", "object"],
      ["navigate", "embed"],
      ["navigate", "frame"],
    ]) {
      const headers = { ...crossSite, "Sec-Fetch-Mode": mode!, "Sec-Fetch-Dest": dest! };
      expect(status(request("GET", headers))).toBe(403);
    }
    expect(status(request("GET", { ...crossSite, "Sec-Fetch-Mode": "navigate" }))).toBe(403);
  });

  test("admits same-origin subresource loads such as the media viewer's frame content", () => {
    const image = { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "no-cors" };
    expect(status(request("GET", { ...image, "Sec-Fetch-Dest": "image" }))).toBeNull();
    expect(status(request("GET", { ...image, "Sec-Fetch-Dest": "video" }))).toBeNull();
    const frame = { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate" };
    expect(status(request("GET", { ...frame, "Sec-Fetch-Dest": "iframe" }))).toBeNull();
  });
});

describe("checkRequest: mutation bodies", () => {
  test("admits JSON mutations, including charset parameters and mixed case", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(status(request(method, { "Content-Type": "application/json" }))).toBeNull();
    }
    const charset = { "Content-Type": "application/json; charset=utf-8" };
    expect(status(request("DELETE", charset))).toBeNull();
    expect(status(request("PUT", { "Content-Type": "Application/JSON" }))).toBeNull();
  });

  test("rejects mutations without a JSON content type with 415", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(status(request(method))).toBe(415);
    }
    const textPost = request("POST", { "Content-Type": "text/plain" });
    expect(checkRequest(textPost, "app", prod)).toMatchObject({
      status: 415,
      details: { contentType: "text/plain" },
    });
    for (const type of ["application/x-www-form-urlencoded", "multipart/form-data", ""]) {
      expect(status(request("POST", { "Content-Type": type }))).toBe(415);
    }
  });

  test("leaves non-mutating methods alone", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(status(request(method))).toBeNull();
      expect(status(request(method, { "Content-Type": "text/plain" }))).toBeNull();
    }
  });
});

describe("checkRequest: GET /api/terminals", () => {
  // It lists the user's terminals and the programs running in them. The checks are the same for
  // every path, which is what keeps it from other sites.
  test("refuses other sites, whether they send an Origin or only Sec-Fetch-Site", () => {
    expect(status(request("GET", { Origin: "https://evil.example" }))).toBe(403);
    expect(
      status(request("GET", { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" })),
    ).toBe(403);
  });

  test("serves the app's own renderer and native clients", () => {
    expect(status(request("GET", { Origin: `http://127.0.0.1:${PORT}` }))).toBeNull();
    expect(status(request("GET"))).toBeNull();
  });
});

describe("checkRequest: principals", () => {
  // Over the Unix socket: no browser can connect there, and Host names no address.
  const cli = (method: string, pathname: string, headers: Record<string, string> = {}) =>
    status({ method, headers: new Headers(headers), pathname }, prod, "cli");

  test("the CLI gets the routes it uses, whatever its Host", () => {
    expect(cli("GET", "/api/version")).toBeNull();
    expect(cli("GET", "/api/version", { Host: "localhost" })).toBeNull();
    expect(cli("POST", "/api/open", { "Content-Type": "application/json" })).toBeNull();
  });

  test("the CLI gets no other route, WebSocket or static file", () => {
    for (const [method, pathname] of [
      ["GET", "/api/projects"],
      ["GET", "/api/terminals"],
      ["POST", "/api/projects"],
      ["GET", "/api/open"],
      ["POST", "/api/version"],
      ["GET", "/ws"],
      ["GET", "/"],
      ["GET", "/index.html"],
    ] as const) {
      expect(cli(method, pathname, { "Content-Type": "application/json" })).toBe(403);
    }
    const rejection = checkRequest(
      { method: "GET", headers: new Headers(), pathname: "/api/projects" },
      "cli",
      prod,
    );
    expect(rejection).toMatchObject({ status: 403, details: { principal: "cli" } });
  });

  test("the CLI's mutations must still be JSON", () => {
    expect(cli("POST", "/api/open")).toBe(415);
    expect(cli("POST", "/api/open", { "Content-Type": "text/plain" })).toBe(415);
  });

  test("the app gets every route, the CLI's included", () => {
    expect(status(request("GET", {}, "/api/version"))).toBeNull();
    expect(status(jsonPost({}))).toBeNull();
    expect(status(request("GET", {}, "/ws"))).toBeNull();
    expect(status(request("GET", {}, "/"))).toBeNull();
  });
});

describe("checkRequest: the app's session over TCP", () => {
  const anonymous = (method: string, pathname: string, headers: Record<string, string> = {}) =>
    status(request(method, headers, pathname), prod, "anonymous");

  test("without the secret, only the version and static files are served", () => {
    expect(anonymous("GET", "/api/version")).toBeNull();
    expect(anonymous("GET", "/")).toBeNull();
    expect(anonymous("GET", "/assets/index-abc123.js")).toBeNull();
  });

  test("without the secret, every other /api and /ws path is a 401", () => {
    for (const [method, pathname] of [
      ["GET", "/api/projects"],
      ["GET", "/api/terminals"],
      ["GET", "/api/session"],
      ["POST", "/api/open"],
      ["POST", "/api/version"],
      ["GET", "/api"],
      ["GET", "/apifoo"],
      ["GET", "/ws"],
      ["GET", "/ws/ts-lsp"],
    ] as const) {
      expect(anonymous(method, pathname, { "Content-Type": "application/json" })).toBe(401);
    }
    const rejection = checkRequest(request("GET", {}, "/api/projects"), "anonymous", prod);
    expect(rejection).toMatchObject({ status: 401, details: { principal: "anonymous" } });
  });

  test("the browser rules still apply without the secret", () => {
    expect(anonymous("GET", "/", { Host: "evil.example" })).toBe(400);
    expect(anonymous("GET", "/api/version", { Origin: "https://evil.example" })).toBe(403);
  });
});

describe("tcpPrincipal", () => {
  const secret = newSessionSecret();
  const principal = (headers: Record<string, string>) => tcpPrincipal(new Headers(headers), secret);

  test("is the app with the secret as a Bearer header", () => {
    expect(principal({ Authorization: bearer(secret) })).toBe("app");
    expect(principal({ Authorization: `bearer ${secret}` })).toBe("app");
  });

  test("is anonymous without the secret, or with any other value", () => {
    expect(principal({})).toBe("anonymous");
    expect(principal({ Authorization: bearer(newSessionSecret()) })).toBe("anonymous");
    expect(principal({ Authorization: bearer(secret.slice(1)) })).toBe("anonymous");
    expect(principal({ Authorization: secret })).toBe("anonymous");
    expect(principal({ Authorization: `Basic ${secret}` })).toBe("anonymous");
    expect(principal({ Authorization: "Bearer " })).toBe("anonymous");
    expect(principal({ Cookie: `session=${secret}` })).toBe("anonymous");
  });
});
