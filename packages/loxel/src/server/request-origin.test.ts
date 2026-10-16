import { describe, expect, test } from "bun:test";

import { type RequestOriginPolicy, checkRequest } from "./request-origin";

const PORT = 7433;
const prod: RequestOriginPolicy = { port: PORT, allowDevOrigins: false };
const dev: RequestOriginPolicy = { port: 7434, allowDevOrigins: true };

// Built from headers rather than `new Request(...)`: the test DOM preload's Request strips the
// `Host` and `Origin` headers these rules inspect.
function request(method: string, headers: Record<string, string> = {}) {
  return { method, headers: new Headers({ Host: `127.0.0.1:${PORT}`, ...headers }) };
}

const jsonPost = (headers: Record<string, string> = {}) =>
  request("POST", { "Content-Type": "application/json", ...headers });

const status = (req: ReturnType<typeof request>, policy = prod) =>
  checkRequest(req, policy)?.status ?? null;

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
    expect(status({ method: "GET", headers: new Headers() })).toBe(400);
  });

  test("reports the offending host and checks Host before anything else", () => {
    const rejection = checkRequest(
      request("POST", {
        Host: "evil.example",
        Origin: "https://evil.example",
        "Content-Type": "text/plain",
      }),
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
    const rejection = checkRequest(jsonPost({ Origin: "https://evil.example" }), prod);
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

  test("rejects cross-site requests of any method except top-level navigations", () => {
    expect(status(jsonPost({ "Sec-Fetch-Site": "cross-site" }))).toBe(403);
    expect(status(request("GET", { "Sec-Fetch-Site": "cross-site" }))).toBe(403);
    expect(
      status(request("GET", { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors" })),
    ).toBe(403);
    expect(
      status(request("GET", { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" })),
    ).toBeNull();
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
    expect(checkRequest(textPost, prod)).toMatchObject({
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
