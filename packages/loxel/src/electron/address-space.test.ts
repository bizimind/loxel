import { describe, expect, test } from "bun:test";

import {
  type AddressSpace,
  ipAddressSpace,
  isMorePrivate,
  literalHostSpace,
  mostPrivate,
} from "./address-space";

describe("ipAddressSpace", () => {
  test.each([
    ["127.0.0.1", "loopback"],
    ["127.255.0.9", "loopback"],
    ["0.0.0.0", "loopback"],
    ["::1", "loopback"],
    ["::", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["10.1.2.3", "local"],
    ["172.16.0.1", "local"],
    ["172.31.255.255", "local"],
    ["192.168.1.1", "local"],
    ["169.254.169.254", "local"],
    ["100.100.1.1", "local"],
    ["0.1.2.3", "local"],
    ["fd12:3456::1", "local"],
    ["fc00::1", "local"],
    ["fe80::1", "local"],
    ["::ffff:192.168.0.1", "local"],
    ["::ffff:c0a8:1", "local"],
    ["8.8.8.8", "public"],
    ["172.32.0.1", "public"],
    ["192.169.0.1", "public"],
    ["100.128.0.1", "public"],
    ["2606:4700::1111", "public"],
    ["::ffff:8.8.8.8", "public"],
  ] satisfies [string, AddressSpace][])("%s is %s", (address, space) => {
    expect(ipAddressSpace(address)).toBe(space);
  });

  test("anything else is no address", () => {
    expect(ipAddressSpace("example.com")).toBeNull();
    expect(ipAddressSpace("1.2.3")).toBeNull();
  });
});

describe("literalHostSpace", () => {
  test("names this machine, the local network, or nothing", () => {
    expect(literalHostSpace("localhost")).toBe("loopback");
    expect(literalHostSpace("app.localhost")).toBe("loopback");
    expect(literalHostSpace("LOCALHOST.")).toBe("loopback");
    expect(literalHostSpace("[::1]")).toBe("loopback");
    expect(literalHostSpace("printer.local")).toBe("local");
    expect(literalHostSpace("192.168.0.10")).toBe("local");
    expect(literalHostSpace("93.184.216.34")).toBe("public");
    // A name's space is that of what it resolves to.
    expect(literalHostSpace("localtest.me")).toBeNull();
    expect(literalHostSpace("notlocalhost")).toBeNull();
  });
});

describe("isMorePrivate", () => {
  test("public pages need permission for the local network and this machine", () => {
    expect(isMorePrivate("local", "public")).toBe(true);
    expect(isMorePrivate("loopback", "public")).toBe(true);
    expect(isMorePrivate("public", "public")).toBe(false);
  });

  test("local network pages need it for this machine; pages on this machine never do", () => {
    expect(isMorePrivate("loopback", "local")).toBe(true);
    expect(isMorePrivate("local", "local")).toBe(false);
    expect(isMorePrivate("public", "local")).toBe(false);
    expect(isMorePrivate("loopback", "loopback")).toBe(false);
    expect(isMorePrivate("local", "loopback")).toBe(false);
  });

  test("the more private of two spaces", () => {
    expect(mostPrivate("public", "local")).toBe("local");
    expect(mostPrivate("loopback", "local")).toBe("loopback");
  });
});
