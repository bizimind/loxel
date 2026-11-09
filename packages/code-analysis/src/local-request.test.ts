import { expect, test } from "bun:test";

import { isLocalRequest } from "./local-request.ts";

const PORT = 47_123;

function request(headers: Record<string, string>): Request {
  return new Request(`http://127.0.0.1:${PORT}/data.json`, { headers });
}

test.each([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `LOCALHOST:${PORT}`])(
  "accepts a request whose Host is %s",
  (host) => {
    expect(isLocalRequest(request({ host }), PORT)).toBe(true);
  },
);

test.each(["example.com", `example.com:${PORT}`, "127.0.0.1", `127.0.0.1:${PORT + 1}`])(
  "refuses a request whose Host is %s",
  (host) => {
    expect(isLocalRequest(request({ host }), PORT)).toBe(false);
  },
);

test("accepts the server's own page as Origin", () => {
  const headers = { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` };
  expect(isLocalRequest(request(headers), PORT)).toBe(true);
});

test.each(["https://example.com", `http://example.com:${PORT}`, "null"])(
  "refuses a request from Origin %s",
  (origin) => {
    expect(isLocalRequest(request({ host: `127.0.0.1:${PORT}`, origin }), PORT)).toBe(false);
  },
);

test("refuses a request with no Host", () => {
  expect(isLocalRequest(request({}), PORT)).toBe(false);
});

test.each([`http://127.0.0.1:${PORT}`, `http://LOCALHOST:${PORT}`])(
  "accepts Origin %s",
  (origin) => {
    expect(isLocalRequest(request({ host: `localhost:${PORT}`, origin }), PORT)).toBe(true);
  },
);

test.each<Record<string, string>>([
  { host: `localhost:${PORT}`, origin: `https://localhost:${PORT}` },
  { host: `evil.example:${PORT}, localhost:${PORT}` },
  { host: `localhost:${PORT}`, origin: `https://evil.example, http://localhost:${PORT}` },
])("refuses %o", (headers) => {
  expect(isLocalRequest(request(headers), PORT)).toBe(false);
});

test("refuses a cross-site subresource request", () => {
  const headers = {
    host: `127.0.0.1:${PORT}`,
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "no-cors",
    "sec-fetch-dest": "script",
  };
  expect(isLocalRequest(request(headers), PORT)).toBe(false);
});

test("accepts a cross-site top-level navigation to the page", () => {
  const headers = {
    host: `localhost:${PORT}`,
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  };
  expect(isLocalRequest(request(headers), PORT)).toBe(true);
});
