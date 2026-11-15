/**
 * The protocol's schemas cannot change without TERMINAL_HOST_PROTOCOL: the snapshot next to this
 * file is compared with the current schemas, and a change needs the bump protocol-snapshot.ts
 * names. After a correct bump, refresh the snapshot:
 *
 *   UPDATE_PROTOCOL_SNAPSHOT=1 bun test src/terminal-host/protocol-schema.test.ts
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { ProtocolSnapshot, SnapshotVerdict } from "./protocol-snapshot";
import { bumpBetween, currentProtocolSnapshot, snapshotVerdict } from "./protocol-snapshot";

const SNAPSHOT_FILE = join(import.meta.dir, "protocol-schema.snapshot.json");

describe("protocol schema snapshot", () => {
  test("the schemas match the snapshot of TERMINAL_HOST_PROTOCOL", async () => {
    const current = currentProtocolSnapshot();
    const committed = (await Bun.file(SNAPSHOT_FILE).json()) as ProtocolSnapshot;
    const verdict = snapshotVerdict(committed, current);
    if (verdict.status === "invalid") throw new Error(verdict.message);
    if (verdict.status === "outdated") {
      if (!process.env.UPDATE_PROTOCOL_SNAPSHOT) {
        throw new Error(
          "The protocol changed with a fitting TERMINAL_HOST_PROTOCOL bump; refresh the snapshot with UPDATE_PROTOCOL_SNAPSHOT=1 bun test src/terminal-host/protocol-schema.test.ts",
        );
      }
      await Bun.write(SNAPSHOT_FILE, `${JSON.stringify(current, null, 2)}\n`);
    }
  });
});

/** Why a change was refused; empty when it was not. */
function refusal(verdict: SnapshotVerdict): string {
  return verdict.status === "invalid" ? verdict.message : "";
}

describe("snapshotVerdict", () => {
  const base = currentProtocolSnapshot();
  const [major, minor] = base.protocol.split(".").map(Number);
  /** The version a change needing a minor bump of `base` would take. */
  const nextMinor = `${major}.${minor! + 1}.0`;
  const withProtocol = (snapshot: ProtocolSnapshot, protocol: string) => ({
    ...snapshot,
    protocol,
  });
  /** `base` with one versioned server message replaced. */
  const withServerMessage = (type: string, schema: unknown): ProtocolSnapshot => ({
    ...base,
    server: { ...base.server, [type]: schema },
  });
  const resize = base.server.resize as { properties: Record<string, unknown>; required: string[] };

  test("an unchanged protocol is current", () => {
    expect(snapshotVerdict(base, currentProtocolSnapshot())).toEqual({ status: "current" });
  });

  test("a new optional field needs a minor bump", () => {
    const after = withServerMessage("resize", {
      ...resize,
      properties: { ...resize.properties, hint: { type: "string" } },
    });
    const message = refusal(snapshotVerdict(base, after));
    expect(message).toContain("without a minor bump");
    expect(message).toContain("server resize.hint is a new optional field");
    expect(snapshotVerdict(base, withProtocol(after, nextMinor))).toEqual({ status: "outdated" });
  });

  test("a removed field, a new required one or a retyped one needs a major bump", () => {
    const { cols: _cols, ...withoutCols } = resize.properties;
    for (const after of [
      withServerMessage("resize", { ...resize, properties: withoutCols }),
      withServerMessage("resize", {
        ...resize,
        properties: { ...resize.properties, hint: { type: "string" } },
        required: [...resize.required, "hint"],
      }),
      withServerMessage("resize", {
        ...resize,
        properties: { ...resize.properties, cols: { type: "string" } },
      }),
    ]) {
      expect(refusal(snapshotVerdict(base, withProtocol(after, "1.9.0")))).toContain(
        "without a major bump",
      );
      expect(snapshotVerdict(base, withProtocol(after, "2.0.0"))).toEqual({ status: "outdated" });
    }
  });

  test("a new message needs a new capability to gate it, and a minor bump", () => {
    const after = withServerMessage("fly", { type: "object", properties: {}, required: [] });
    expect(refusal(snapshotVerdict(base, withProtocol(after, nextMinor)))).toContain(
      "need a new capability",
    );
    const gated = { ...after, capabilities: [...base.capabilities, "fly"] };
    expect(refusal(snapshotVerdict(base, gated))).toContain("without a minor bump");
    expect(snapshotVerdict(base, withProtocol(gated, nextMinor))).toEqual({ status: "outdated" });
  });

  test("the bootstrap layer may gain an optional field, never lose or retype one", () => {
    const result = base.bootstrap.initialize_result as { properties: Record<string, unknown> };
    const { sessions: _sessions, ...withoutSessions } = result.properties;
    const removed = {
      ...base,
      bootstrap: {
        ...base.bootstrap,
        initialize_result: { ...result, properties: withoutSessions },
      },
    };
    expect(refusal(snapshotVerdict(base, withProtocol(removed, "2.0.0")))).toContain(
      "bootstrap layer is frozen",
    );
    expect(snapshotVerdict(removed, withProtocol(base, nextMinor))).toEqual({ status: "outdated" });
  });

  test("a new bootstrap message is refused: a peer from before it could not parse it", () => {
    const after = {
      ...base,
      bootstrap: { ...base.bootstrap, ping: { type: "object", properties: {}, required: [] } },
    };
    expect(refusal(snapshotVerdict(base, withProtocol(after, nextMinor)))).toContain(
      "bootstrap layer is frozen",
    );
  });

  test("an answer's schema is guarded like a message's, a list's items included", () => {
    const list = base.answers.list as { items: { properties: object; required: string[] } };
    const after = {
      ...base,
      answers: {
        ...base.answers,
        list: {
          ...list,
          items: {
            ...list.items,
            properties: { ...list.items.properties, title: { type: "string" } },
            required: [...list.items.required, "title"],
          },
        },
      },
    };
    expect(refusal(snapshotVerdict(base, withProtocol(after, nextMinor)))).toContain(
      "answer of list[].title is a new required field",
    );
    expect(snapshotVerdict(base, withProtocol(after, "2.0.0"))).toEqual({ status: "outdated" });
  });

  test("a version that goes down or is not semver is refused", () => {
    expect(refusal(snapshotVerdict(base, withProtocol(base, "1.0.9")))).toContain("only go up");
    expect(bumpBetween("1.1.0", "1.1")).toBeNull();
    expect(bumpBetween("1.1.0", "1.1.1")).toBe("patch");
  });
});
