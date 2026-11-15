import { describe, expect, test } from "bun:test";

import { endedHostsNotice } from "./ended-hosts-notice";

describe("endedHostsNotice", () => {
  test("counts the terminals of the hosts that were ended", () => {
    expect(
      endedHostsNotice([
        { hostId: "a", protocol: "2.0.0", sessions: 2 },
        { hostId: "b", protocol: "2.0.0", sessions: 1 },
      ]),
    ).toEqual({
      title: "3 terminals were ended (incompatible terminal host)",
      body: "They ran in a terminal host this version of Loxel cannot talk to (protocol 2.0.0).",
    });
    expect(endedHostsNotice([{ hostId: "a", protocol: "2.1.0", sessions: 1 }])?.title).toBe(
      "1 terminal was ended (incompatible terminal host)",
    );
  });

  test("leaves the count out when a host did not say (a 1.0.0 host)", () => {
    expect(
      endedHostsNotice([
        { hostId: "a", protocol: "2.0.0", sessions: 2 },
        { hostId: "b", protocol: "0.9.0", sessions: null },
      ]),
    ).toEqual({
      title: "Terminals were ended (incompatible terminal host)",
      body: "They ran in a terminal host this version of Loxel cannot talk to (protocol 2.0.0, 0.9.0).",
    });
  });

  test("says nothing when no terminal ended", () => {
    expect(endedHostsNotice([])).toBeNull();
    expect(endedHostsNotice([{ hostId: "a", protocol: "2.0.0", sessions: 0 }])).toBeNull();
  });
});
