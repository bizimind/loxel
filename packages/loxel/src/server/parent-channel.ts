/**
 * Reading the desktop app's messages to the server it started, and answering them, on the channel
 * described in [parent-channel-protocol.ts](../parent-channel-protocol.ts).
 */
import { createReadStream, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import {
  PARENT_CHANNEL_FD,
  type ServerMessage,
  type ShutdownTerminals,
  encodeServerMessage,
  parseParentMessage,
} from "@/parent-channel-protocol";

import { logger } from "./logger";

const log = logger.child("server");

export interface ParentListener {
  /** The app's session secret and its open windows' IDs, its first message. */
  session(secret: string, windowIds: string[]): void;
  /** The app asked the server to shut down, doing `terminals` to the terminals. */
  shutdown(terminals: ShutdownTerminals): void;
  /** The channel closed without a shutdown: the app is gone. */
  closed(): void;
}

/** Follow the app's messages on `input`, a line each, until it closes. */
export function listenToParent(input: Readable, listener: ParentListener): void {
  const reader = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  reader.on("line", (line) => {
    const message = parseParentMessage(line);
    if (!message) {
      log.warn("Ignoring a line on the app's channel that is not a message");
      return;
    }
    if (message.type === "session") listener.session(message.secret, message.windowIds);
    else listener.shutdown(message.terminals);
  });
  reader.on("close", () => listener.closed());
}

/** The app's channel, in a server the app started. */
export function parentChannelInput(): Readable {
  return createReadStream("", { fd: PARENT_CHANNEL_FD });
}

/** Tell the app `message` on its channel; an app that is gone has closed it, which is logged. */
export function tellParent(message: ServerMessage): void {
  try {
    writeSync(PARENT_CHANNEL_FD, encodeServerMessage(message));
  } catch (err) {
    log.warn(`Could not tell the app ${message.type} on its channel`, { error: err });
  }
}
