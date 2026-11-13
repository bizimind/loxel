/**
 * The terminal host protocol: the messages a server and a terminal host exchange over the host's
 * Unix socket, framed by protocol-framing.ts. Two layers:
 *
 * - The bootstrap layer (`initialize`, `initialize_result`, `disconnect`, `terminate`,
 *   `superseded`, and the framing) is frozen: it never changes, so any server can identify and stop any host, even one
 *   of an incompatible major version.
 * - The versioned layer carries the `TerminalHost` interface (terminal-host.ts) and changes with
 *   {@link TERMINAL_HOST_PROTOCOL}: a major bump for any incompatible change, a minor one for a new
 *   capability, which code checks by name, never by comparing versions. protocol-schema.test.ts
 *   fails when the schemas change without a bump.
 *
 * Keyboard input and output travel as binary frames in the renderer's layout (terminal-stream.ts);
 * everything else is JSON. See docs/TERMINAL_HOST.md#protocol.
 */
import { z } from "zod";

import { protocolMajor } from "@/api/terminal-host-protocol-version";

import {
  ForegroundProcessesSchema,
  TerminalAttachRequestSchema,
  TerminalExitEventSchema,
  TerminalOscEventSchema,
  TerminalSessionInfoSchema,
  TerminalSessionMetaSchema,
  TerminalSpawnSpecSchema,
  TerminalStateEventSchema,
} from "./terminal-host";

/**
 * Optional features of the versioned layer this build supports, by name. Each came with a minor
 * version, and its messages go only to a peer that advertises it too (see `compatibility()`):
 *
 * - `foregroundProcess` (1.1.0): `foreground_processes`, each session's foreground program.
 * - `endedSessions` (1.2.0): while no server is connected, the host keeps the sessions whose program
 *   ends, which `list` reports with their `exitCode` and an attach drains before their `exit`, and
 *   queues their `osc` events, which it sends after `initialize_result`. Without it in a server's
 *   `initialize`, the host forgets both when that server connects.
 */
export const TERMINAL_HOST_CAPABILITIES = ["foregroundProcess", "endedSessions"] as const;
export type TerminalHostCapability = (typeof TERMINAL_HOST_CAPABILITIES)[number];

function isTerminalHostCapability(name: string): name is TerminalHostCapability {
  return (TERMINAL_HOST_CAPABILITIES as readonly string[]).includes(name);
}

// --- Bootstrap layer (frozen) ---
//
// Frozen means every server must be able to read what any host sends here, and the reverse, so
// these schemas only ever gain optional fields: none is removed, renamed or retyped, and every
// reader tolerates an optional field's absence (a peer from before it). protocol-schema.test.ts
// holds them to that.

/** The server's first message on a connection; nothing else is valid before it. */
export const InitializeSchema = z.object({
  type: z.literal("initialize"),
  protocol: z.string(),
  /** The server's build, for the host's logs. */
  build: z.string(),
  capabilities: z.array(z.string()),
});
export type InitializeMessage = z.infer<typeof InitializeSchema>;

/** The host's answer to `initialize`, whatever version the server speaks. */
export const InitializeResultSchema = z.object({
  type: z.literal("initialize_result"),
  protocol: z.string(),
  hostBuildId: z.string(),
  pid: z.number().int(),
  capabilities: z.array(z.string()),
  /**
   * How many sessions the host runs, so a server that cannot talk to it can still say how many
   * terminals ending it ends. Since 1.1.0; a 1.0.0 host leaves it out.
   */
  sessions: z.number().int().nonnegative().optional(),
});
export type InitializeResult = z.infer<typeof InitializeResultSchema>;

/**
 * The server is leaving. `end` ends every session, `keep` keeps them running until a server comes
 * back. A connection that closes without one gets the grace period instead.
 */
export const DisconnectSchema = z.object({
  type: z.literal("disconnect"),
  sessions: z.enum(["end", "keep"]),
});
export type DisconnectMode = z.infer<typeof DisconnectSchema>["sessions"];

/** End every session and exit. */
export const TerminateSchema = z.object({ type: z.literal("terminate") });

/**
 * From the host to a server another server has taken it over from, right before it closes that
 * connection: the server is done with the host and must not reconnect to it.
 */
export const SupersededSchema = z.object({ type: z.literal("superseded") });

// --- Versioned layer, v1 ---

const RequestIdSchema = z.number().int();
const IdSchema = z.string();

/** Requests: answered by a `result` or an `error` with the same `requestId`. */
const SpawnSchema = z.object({
  type: z.literal("spawn"),
  requestId: RequestIdSchema,
  request: TerminalSpawnSpecSchema,
});
const ListSchema = z.object({ type: z.literal("list"), requestId: RequestIdSchema });
const AttachSchema = z.object({
  type: z.literal("attach"),
  requestId: RequestIdSchema,
  request: TerminalAttachRequestSchema,
});

/** Commands with no answer. Keyboard input is a binary input frame. */
const DetachSchema = z.object({ type: z.literal("detach"), id: IdSchema });
const ResizeSchema = z.object({
  type: z.literal("resize"),
  id: IdSchema,
  cols: z.number().int(),
  rows: z.number().int(),
});
const SetScrollbackSchema = z.object({
  type: z.literal("set_scrollback"),
  id: IdSchema,
  lines: z.number().int(),
});
const AckSchema = z.object({
  type: z.literal("ack"),
  id: IdSchema,
  syncOffset: z.number().int(),
  bytes: z.number().int(),
});
const DestroySchema = z.object({ type: z.literal("destroy"), id: IdSchema });
const SetMetaSchema = z.object({
  type: z.literal("set_meta"),
  id: IdSchema,
  meta: TerminalSessionMetaSchema,
});

/**
 * Capability `foregroundProcess`: each session's foreground program. Answered with
 * {@link ForegroundProcessesSchema}.
 */
const ForegroundProcessesRequestSchema = z.object({
  type: z.literal("foreground_processes"),
  requestId: RequestIdSchema,
});

/** Every JSON message a server sends. */
export const ServerMessageSchema = z.discriminatedUnion("type", [
  InitializeSchema,
  DisconnectSchema,
  TerminateSchema,
  SpawnSchema,
  ListSchema,
  AttachSchema,
  DetachSchema,
  ResizeSchema,
  SetScrollbackSchema,
  AckSchema,
  DestroySchema,
  SetMetaSchema,
  ForegroundProcessesRequestSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/**
 * What each request is answered with: the `value` of its `result`, which the requester parses with
 * this schema. Part of the versioned layer like the messages, so the schema guard covers them.
 */
export const RESULT_SCHEMAS = {
  spawn: TerminalSessionInfoSchema,
  list: TerminalSessionInfoSchema.array(),
  attach: z.null(),
  foreground_processes: ForegroundProcessesSchema,
} as const satisfies Record<Extract<ServerMessage, { requestId: number }>["type"], z.ZodType>;

/** A request's answer; the requester parses `value` with the schema of what it asked for. */
const ResultSchema = z.object({
  type: z.literal("result"),
  requestId: RequestIdSchema,
  value: z.unknown(),
});
/** A request that failed, with the error's message and its cause's. */
const ErrorSchema = z.object({
  type: z.literal("error"),
  requestId: RequestIdSchema,
  message: z.string(),
  cause: z.string().optional(),
});

export const HostLogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

/** A line of the host's log, for the server to log as its own. */
const LogSchema = z.object({
  type: z.literal("log"),
  level: HostLogLevelSchema,
  msg: z.string(),
  ctx: z.record(z.string(), z.unknown()).optional(),
});
export type HostLogMessage = z.infer<typeof LogSchema>;

/** Every JSON message a host sends. Output is a binary output frame. */
export const HostMessageSchema = z.discriminatedUnion("type", [
  InitializeResultSchema,
  SupersededSchema,
  ResultSchema,
  ErrorSchema,
  TerminalStateEventSchema,
  TerminalExitEventSchema,
  TerminalOscEventSchema,
  LogSchema,
]);
export type HostMessage = z.infer<typeof HostMessageSchema>;

// --- Compatibility ---

export interface ProtocolPeer {
  protocol: string;
  capabilities: readonly string[];
}

export type Compatibility =
  /** Same major, and every capability either side has, both have. */
  | { status: "compatible"; capabilities: ReadonlySet<string> }
  /** Same major; some capabilities only one side has go unused. */
  | { status: "degraded"; capabilities: ReadonlySet<string>; unshared: readonly string[] }
  /** The server cannot talk to the host: it ends it. */
  | { status: "incompatible"; reason: string };

/**
 * Whether a server can use a host. A different major (or a version that is not semver) is
 * incompatible; otherwise each side uses only the capabilities both advertise, so an older server
 * talks to a newer host and the reverse.
 */
export function compatibility(host: ProtocolPeer, server: ProtocolPeer): Compatibility {
  const hostMajor = protocolMajor(host.protocol);
  const serverMajor = protocolMajor(server.protocol);
  if (hostMajor === null || serverMajor === null) {
    return {
      status: "incompatible",
      reason: `unreadable protocol version (host ${host.protocol}, server ${server.protocol})`,
    };
  }
  if (hostMajor !== serverMajor) {
    return {
      status: "incompatible",
      reason: `protocol ${host.protocol} is not compatible with ${server.protocol}`,
    };
  }
  const hostCapabilities = new Set(host.capabilities);
  const serverCapabilities = new Set(server.capabilities);
  const capabilities = new Set(
    [...hostCapabilities].filter((name) => serverCapabilities.has(name)),
  );
  const unshared = [...new Set([...hostCapabilities, ...serverCapabilities])].filter(
    (name) => !capabilities.has(name),
  );
  return unshared.length === 0
    ? { status: "compatible", capabilities }
    : { status: "degraded", capabilities, unshared };
}

/**
 * The capabilities this build may use with a peer: the ones both advertise. Code checks a
 * capability by name here before sending its messages, never by comparing versions; a name only
 * the peer advertises is one this build does not know, and is left out.
 */
export function sharedCapabilities(
  peer: ProtocolPeer,
  own: ProtocolPeer,
): ReadonlySet<TerminalHostCapability> {
  const verdict = compatibility(peer, own);
  if (verdict.status === "incompatible") return new Set();
  return new Set([...verdict.capabilities].filter(isTerminalHostCapability));
}
