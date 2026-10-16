import { describe, expect, test } from "bun:test";

import {
  type RequestOriginPolicy,
  allowedOrigins,
  checkRequest,
  isAllowedOrigin,
  isLoopbackHost,
} from "./request-origin";

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

describe("isLoopbackHost", () => {
  test("accepts loopback hosts on the server port only", () => {
    expect(isLoopbackHost("127.0.0.1:7433", PORT)).toBe(true);
    expect(isLoopbackHost("localhost:7433", PORT)).toBe(true);
    expect(isLoopbackHost("LOCALHOST:7433", PORT)).toBe(true);
    expect(isLoopbackHost("[::1]:7433", PORT)).toBe(true);
    expect(isLoopbackHost("127.0.0.1:7434", PORT)).toBe(false);
    expect(isLoopbackHost("127.0.0.1", PORT)).toBe(false);
    expect(isLoopbackHost("evil.example:7433", PORT)).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.example:7433", PORT)).toBe(false);
    expect(isLoopbackHost(null, PORT)).toBe(false);
    expect(isLoopbackHost("", PORT)).toBe(false);
  });
});

describe("isAllowedOrigin", () => {
  test("allows requests without an Origin header (non-browser clients)", () => {
    expect(isAllowedOrigin(null, prod)).toBe(true);
  });

  test("allows the server's own loopback origins", () => {
    expect(isAllowedOrigin("http://127.0.0.1:7433", prod)).toBe(true);
    expect(isAllowedOrigin("http://localhost:7433", prod)).toBe(true);
    expect(isAllowedOrigin("HTTP://LOCALHOST:7433", prod)).toBe(true);
  });

  test("rejects foreign, null, https, and wrong-port origins", () => {
    expect(isAllowedOrigin("https://evil.example", prod)).toBe(false);
    expect(isAllowedOrigin("null", prod)).toBe(false);
    expect(isAllowedOrigin("https://127.0.0.1:7433", prod)).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:7434", prod)).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:7433.evil.example", prod)).toBe(false);
    expect(isAllowedOrigin("http://localhost:5173", prod)).toBe(false);
  });

  test("allows the Vite dev-server origin only when dev origins are enabled", () => {
    expect(isAllowedOrigin("http://localhost:5173", dev)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:5173", dev)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:7434", dev)).toBe(true);
    expect(allowedOrigins(dev)).toContain("http://127.0.0.1:5173");
    expect(allowedOrigins(prod)).not.toContain("http://127.0.0.1:5173");
  });
});

describe("checkRequest", () => {
  test("admits GET requests from native clients and the app's own origin", () => {
    expect(checkRequest(request("GET"), prod)).toBeNull();
    expect(checkRequest(request("GET", { Origin: `http://localhost:${PORT}` }), prod)).toBeNull();
    expect(checkRequest(request("GET", { Host: `localhost:${PORT}` }), prod)).toBeNull();
  });

  test("rejects any request whose Host is not this server", () => {
    expect(checkRequest(request("GET", { Host: "evil.example" }), prod)).toMatchObject({
      status: 400,
      details: { host: "evil.example" },
    });
    expect(checkRequest(jsonPost({ Host: `127.0.0.1:${PORT + 1}` }), prod)?.status).toBe(400);
  });

  test("rejects any request with a foreign Origin, including GET", () => {
    const rejection = checkRequest(request("GET", { Origin: "https://evil.example" }), prod);
    expect(rejection).toMatchObject({ status: 403, details: { origin: "https://evil.example" } });
    expect(checkRequest(jsonPost({ Origin: "https://evil.example" }), prod)?.status).toBe(403);
    expect(checkRequest(jsonPost({ Origin: "null" }), prod)?.status).toBe(403);
  });

  test("admits JSON mutations from native clients and allowed origins", () => {
    expect(checkRequest(jsonPost(), prod)).toBeNull();
    expect(checkRequest(jsonPost({ Origin: `http://127.0.0.1:${PORT}` }), prod)).toBeNull();
    expect(
      checkRequest(
        jsonPost({ Origin: `http://127.0.0.1:${PORT}`, "Sec-Fetch-Site": "same-origin" }),
        prod,
      ),
    ).toBeNull();
    expect(
      checkRequest(request("DELETE", { "Content-Type": "application/json; charset=utf-8" }), prod),
    ).toBeNull();
  });

  test("rejects mutations marked cross-site by the browser", () => {
    expect(checkRequest(jsonPost({ "Sec-Fetch-Site": "cross-site" }), prod)?.status).toBe(403);
    expect(checkRequest(request("GET", { "Sec-Fetch-Site": "cross-site" }), prod)).toBeNull();
  });

  test("rejects mutations without a JSON content type", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(checkRequest(request(method), prod)?.status).toBe(415);
    }
    const textPost = request("POST", { "Content-Type": "text/plain" });
    expect(checkRequest(textPost, prod)).toMatchObject({
      status: 415,
      details: { contentType: "text/plain" },
    });
    const formPost = request("POST", { "Content-Type": "application/x-www-form-urlencoded" });
    expect(checkRequest(formPost, prod)?.status).toBe(415);
  });

  test("checks Host before Origin and Origin before body rules", () => {
    const everythingWrong = request("POST", {
      Host: "evil.example",
      Origin: "https://evil.example",
      "Content-Type": "text/plain",
    });
    expect(checkRequest(everythingWrong, prod)?.status).toBe(400);
    const badOriginAndBody = request("POST", {
      Origin: "https://evil.example",
      "Content-Type": "text/plain",
    });
    expect(checkRequest(badOriginAndBody, prod)?.status).toBe(403);
  });
});
