/**
 * Reading the desktop app's messages to the server it started, from the channel described in
 * [parent-channel-protocol.ts](../parent-channel-protocol.ts).
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import {
  PARENT_CHANNEL_FD,
  type ShutdownTerminals,
  parseParentMessage,
} from "@/parent-channel-protocol";

import { logger } from "./logger";

const log = logger.child("server");

export interface ParentListener {
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
    listener.shutdown(message.terminals);
  });
  reader.on("close", () => listener.closed());
}

/** The app's channel, in a server the app started. */
export function parentChannelInput(): Readable {
  return createReadStream("", { fd: PARENT_CHANNEL_FD });
}
