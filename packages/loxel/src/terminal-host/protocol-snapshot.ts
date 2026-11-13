/**
 * The guard that keeps {@link TERMINAL_HOST_PROTOCOL} honest: a snapshot of the protocol's message
 * schemas (as JSON Schema) and capabilities, and the bump a change to them needs. The schemas
 * cannot change without the version, and the version says what an older peer can still read:
 *
 * - The bootstrap layer is frozen: it may only gain optional fields.
 * - A versioned message or capability removed, a field removed or retyped, or a field made
 *   required (or optional), needs a major bump: an older peer would misread it.
 * - A new optional field, a new message or a new capability needs a minor bump, and a new message
 *   needs a new capability to gate it, since an older peer cannot parse it.
 * - Requests' answers (`RESULT_SCHEMAS`) follow the same rules as messages. The binary frames'
 *   layout (terminal-stream.ts) is not JSON and is not covered: it changes only with a major bump.
 *
 * protocol-schema.test.ts compares the snapshot committed next to it with the current one. See
 * docs/TERMINAL_HOST.md#versioning.
 */
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { TERMINAL_HOST_PROTOCOL, protocolMajor } from "@/api/terminal-host-protocol-version";

import {
  DisconnectSchema,
  HostMessageSchema,
  InitializeResultSchema,
  RESULT_SCHEMAS,
  InitializeSchema,
  ServerMessageSchema,
  SupersededSchema,
  TERMINAL_HOST_CAPABILITIES,
  TerminateSchema,
} from "./protocol";

/** A JSON Schema document, as `z.toJSONSchema` writes it and the snapshot file stores it. */
type JsonSchema = unknown;

export interface ProtocolSnapshot {
  protocol: string;
  capabilities: string[];
  /** The frozen layer's messages, by type. */
  bootstrap: Record<string, JsonSchema>;
  /** The versioned layer's messages, by type, per direction. */
  server: Record<string, JsonSchema>;
  host: Record<string, JsonSchema>;
  /** What each request is answered with, by request type. */
  answers: Record<string, JsonSchema>;
}

const BOOTSTRAP = {
  initialize: InitializeSchema,
  initialize_result: InitializeResultSchema,
  disconnect: DisconnectSchema,
  terminate: TerminateSchema,
  superseded: SupersededSchema,
};

function messageSchemas(
  union: typeof ServerMessageSchema | typeof HostMessageSchema,
): Record<string, JsonSchema> {
  const schemas: Record<string, JsonSchema> = {};
  for (const option of union.options) {
    const type = option.shape.type.value;
    if (type in BOOTSTRAP) continue;
    schemas[type] = z.toJSONSchema(option, { io: "input" });
  }
  return schemas;
}

/** The snapshot of this build's protocol, as plain JSON. */
export function currentProtocolSnapshot(): ProtocolSnapshot {
  const snapshot: ProtocolSnapshot = {
    protocol: TERMINAL_HOST_PROTOCOL,
    capabilities: [...TERMINAL_HOST_CAPABILITIES],
    bootstrap: Object.fromEntries(
      Object.entries(BOOTSTRAP).map(([type, schema]) => [
        type,
        z.toJSONSchema(schema, { io: "input" }),
      ]),
    ),
    server: messageSchemas(ServerMessageSchema),
    host: messageSchemas(HostMessageSchema),
    answers: Object.fromEntries(
      Object.entries(RESULT_SCHEMAS).map(([type, schema]) => [
        type,
        z.toJSONSchema(schema, { io: "input" }),
      ]),
    ),
  };
  return JSON.parse(JSON.stringify(snapshot)) as ProtocolSnapshot;
}

export type Bump = "none" | "patch" | "minor" | "major";
const RANK: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 };

interface Change {
  bump: "minor" | "major";
  what: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
}

/** The changes from `before` to `after`, one schema of a message or of one of its fields. */
function compareSchemas(path: string, before: unknown, after: unknown, changes: Change[]): void {
  if (isDeepStrictEqual(before, after)) return;
  // A list: what changed is in its items.
  if (isRecord(before) && isRecord(after) && before.type === "array" && after.type === "array") {
    const { items: beforeItems, ...beforeRest } = before;
    const { items: afterItems, ...afterRest } = after;
    if (!isDeepStrictEqual(beforeRest, afterRest)) {
      changes.push({ bump: "major", what: `${path} changed` });
    }
    compareSchemas(`${path}[]`, beforeItems, afterItems, changes);
    return;
  }
  const objects =
    isRecord(before) &&
    isRecord(after) &&
    isRecord(before.properties) &&
    isRecord(after.properties);
  if (!objects) {
    changes.push({ bump: "major", what: `${path} changed` });
    return;
  }
  const { properties: beforeProps, required: beforeRequired, ...beforeRest } = before;
  const { properties: afterProps, required: afterRequired, ...afterRest } = after;
  if (!isRecord(beforeProps) || !isRecord(afterProps)) return;
  if (!isDeepStrictEqual(beforeRest, afterRest)) {
    changes.push({ bump: "major", what: `${path} changed` });
  }
  const wasRequired = stringSet(beforeRequired);
  const isRequired = stringSet(afterRequired);
  for (const key of Object.keys(beforeProps)) {
    if (!(key in afterProps)) changes.push({ bump: "major", what: `${path}.${key} was removed` });
  }
  for (const [key, schema] of Object.entries(afterProps)) {
    const field = `${path}.${key}`;
    if (!(key in beforeProps)) {
      changes.push(
        isRequired.has(key)
          ? { bump: "major", what: `${field} is a new required field` }
          : { bump: "minor", what: `${field} is a new optional field` },
      );
      continue;
    }
    if (wasRequired.has(key) !== isRequired.has(key)) {
      changes.push({
        bump: "major",
        what: `${field} became ${isRequired.has(key) ? "required" : "optional"}`,
      });
    }
    compareSchemas(field, beforeProps[key], schema, changes);
  }
}

function compareMessages(
  layer: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  changes: Change[],
): string[] {
  const added: string[] = [];
  for (const type of Object.keys(before)) {
    if (!(type in after)) changes.push({ bump: "major", what: `${layer} ${type} was removed` });
  }
  for (const [type, schema] of Object.entries(after)) {
    if (type in before) compareSchemas(`${layer} ${type}`, before[type], schema, changes);
    else {
      changes.push({ bump: "minor", what: `${layer} ${type} is a new message` });
      added.push(type);
    }
  }
  return added;
}

/** The bump from version `from` to `to`; null when `to` is not a step up from `from`. */
export function bumpBetween(from: string, to: string): Bump | null {
  const parse = (version: string) => version.split(".").map(Number);
  if (protocolMajor(from) === null || protocolMajor(to) === null) return null;
  const [fromMajor = 0, fromMinor = 0, fromPatch = 0] = parse(from);
  const [toMajor = 0, toMinor = 0, toPatch = 0] = parse(to);
  if (toMajor !== fromMajor) return toMajor > fromMajor ? "major" : null;
  if (toMinor !== fromMinor) return toMinor > fromMinor ? "minor" : null;
  if (toPatch !== fromPatch) return toPatch > fromPatch ? "patch" : null;
  return "none";
}

function suggestedVersion(from: string, bump: "minor" | "major"): string {
  const [major = 0, minor = 0] = from.split(".").map(Number);
  return bump === "major" ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
}

export type SnapshotVerdict =
  | { status: "current" }
  /** The change is versioned correctly; the committed snapshot only needs refreshing. */
  | { status: "outdated" }
  | { status: "invalid"; message: string };

/** Whether the protocol may go from snapshot `before` to `after`, and if not, why. */
export function snapshotVerdict(
  before: ProtocolSnapshot,
  after: ProtocolSnapshot,
): SnapshotVerdict {
  if (isDeepStrictEqual(before, after)) return { status: "current" };

  const frozen: Change[] = [];
  const newBootstrap = compareMessages("bootstrap", before.bootstrap, after.bootstrap, frozen);
  // A peer from before a new bootstrap message could not parse it: only new optional fields.
  const broken = frozen.filter(
    (change) =>
      change.bump === "major" ||
      newBootstrap.some((type) => change.what === `bootstrap ${type} is a new message`),
  );
  if (broken.length > 0) {
    return {
      status: "invalid",
      message: `The bootstrap layer is frozen, so that any server can still identify and stop any host: it may only gain optional fields. Changed: ${broken.map((c) => c.what).join("; ")}.`,
    };
  }

  const changes: Change[] = [...frozen];
  const added = [
    ...compareMessages("server", before.server, after.server, changes),
    ...compareMessages("host", before.host, after.host, changes),
  ];
  compareMessages("answer of", before.answers, after.answers, changes);
  const hadCapability = new Set(before.capabilities);
  const newCapabilities = after.capabilities.filter((name) => !hadCapability.has(name));
  for (const name of before.capabilities) {
    if (!after.capabilities.includes(name)) {
      changes.push({ bump: "major", what: `capability ${name} was removed` });
    }
  }
  for (const name of newCapabilities) {
    changes.push({ bump: "minor", what: `capability ${name} is new` });
  }
  if (added.length > 0 && newCapabilities.length === 0) {
    return {
      status: "invalid",
      message: `New messages (${added.join(", ")}) need a new capability in TERMINAL_HOST_CAPABILITIES to gate them: a peer without it cannot parse them.`,
    };
  }

  const needed: Bump = changes.some((c) => c.bump === "major")
    ? "major"
    : changes.length > 0
      ? "minor"
      : "none";
  const bump = bumpBetween(before.protocol, after.protocol);
  if (bump === null) {
    return {
      status: "invalid",
      message: `TERMINAL_HOST_PROTOCOL went from ${before.protocol} to ${after.protocol}: it must be semver and only go up.`,
    };
  }
  if (needed !== "none" && RANK[bump] < RANK[needed]) {
    const reason =
      needed === "major"
        ? "an older peer would misread it, so this needs a major bump, and installing the update restarts every terminal"
        : "an older peer can ignore it, so this needs a minor bump";
    return {
      status: "invalid",
      message: `The terminal host protocol schemas changed without a ${needed} bump of TERMINAL_HOST_PROTOCOL (${before.protocol}): ${changes.map((c) => c.what).join("; ")}. ${reason[0]!.toUpperCase()}${reason.slice(1)}: make it ${suggestedVersion(before.protocol, needed)} in src/api/terminal-host-protocol-version.ts.`,
    };
  }
  return { status: "outdated" };
}
