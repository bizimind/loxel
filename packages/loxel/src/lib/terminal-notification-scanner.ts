/**
 * Background terminal notification scanner.
 *
 * Scans raw PTY output bytes for OSC notification sequences on terminals
 * that don't have a mounted xterm.js handler (i.e. background worktree terminals).
 * Mounted terminals use xterm.js parser hooks instead (registered in Terminal.tsx).
 *
 * Extracts payload text and sends parsed notifications to the server for
 * multi-instance sync via the notification store.
 */
import type { wsClient as WsClientType } from "@/api/client";

import { usePanelNotificationStore } from "@/store/panel-notifications";
import { useSettingsStore } from "@/store/settings-store";

import type { OscPayload } from "./osc-notification-parser";

import { parseOsc777, parseOsc9, parseOsc99 } from "./osc-notification-parser";

// Byte constants
const ESC = 0x1b;
const OSC_INTRO = 0x5d; // ]
const C1_OSC = 0x9d; // Single-byte OSC introducer
const SEMICOLON = 0x3b; // ;
const DIGIT_7 = 0x37;
const DIGIT_9 = 0x39;
const BEL = 0x07;
const BACKSLASH = 0x5c;

/** Check if bytes at offset match an OSC number followed by semicolon. */
function matchesOsc(data: Uint8Array, offset: number, ...digits: number[]): boolean {
  for (let i = 0; i < digits.length; i++) {
    if (data[offset + i] !== digits[i]) return false;
  }
  return data[offset + digits.length] === SEMICOLON;
}

const textDecoder = new TextDecoder();

/**
 * Extract payload bytes between the semicolon after the OSC number and the
 * string terminator (BEL or ESC \). Returns null if terminator not found
 * in the current chunk (single-chunk only).
 */
function extractPayload(data: Uint8Array, payloadStart: number): string | null {
  for (let i = payloadStart; i < data.length; i++) {
    if (data[i] === BEL) {
      return textDecoder.decode(data.subarray(payloadStart, i));
    }
    if (data[i] === ESC && i + 1 < data.length && data[i + 1] === BACKSLASH) {
      return textDecoder.decode(data.subarray(payloadStart, i));
    }
  }
  return null;
}

interface ScanResult {
  oscType: 9 | 777 | 99;
  payload: string;
}

/** Scan a Uint8Array for OSC 9, 777, or 99 sequences and extract payload. */
function scanForNotification(
  data: Uint8Array,
  osc9: boolean,
  osc777: boolean,
  osc99: boolean,
): ScanResult | null {
  for (let i = 0; i < data.length - 2; i++) {
    let oscBodyStart: number;

    if (data[i] === ESC && data[i + 1] === OSC_INTRO) {
      oscBodyStart = i + 2;
    } else if (data[i] === C1_OSC) {
      oscBodyStart = i + 1;
    } else {
      continue;
    }

    if (oscBodyStart + 2 > data.length) continue;

    // OSC 9 ; — iTerm2 notification
    if (osc9 && matchesOsc(data, oscBodyStart, DIGIT_9)) {
      const payload = extractPayload(data, oscBodyStart + 2);
      if (payload !== null) return { oscType: 9, payload };
    }

    // OSC 99 ; — Kitty notification
    if (
      osc99 &&
      oscBodyStart + 2 < data.length &&
      matchesOsc(data, oscBodyStart, DIGIT_9, DIGIT_9)
    ) {
      const payload = extractPayload(data, oscBodyStart + 3);
      if (payload !== null) return { oscType: 99, payload };
    }

    // OSC 777 ; — rxvt-unicode notification
    if (
      osc777 &&
      oscBodyStart + 3 < data.length &&
      matchesOsc(data, oscBodyStart, DIGIT_7, DIGIT_7, DIGIT_7)
    ) {
      const payload = extractPayload(data, oscBodyStart + 4);
      if (payload !== null) return { oscType: 777, payload };
    }
  }

  return null;
}

/** Initialize the background notification scanner. Call once on app startup. */
export function initTerminalNotificationScanner(client: typeof WsClientType): () => void {
  return client.onTerminalData((terminalId, data) => {
    // Skip terminals with mounted xterm.js handlers — they use parser hooks
    if (client.hasTerminalHandler(terminalId)) return;

    const { osc9, osc777, osc99 } = useSettingsStore.getState().terminal.notificationSequences;
    if (!osc9 && !osc777 && !osc99) return;

    const result = scanForNotification(data, osc9, osc777, osc99);
    if (!result) return;

    const store = usePanelNotificationStore.getState();
    const worktreePath = store.panelWorktreeMap[terminalId];
    if (!worktreePath) return;

    // Parse the payload using the appropriate parser
    let parsed: OscPayload;
    if (result.oscType === 9) parsed = parseOsc9(result.payload);
    else if (result.oscType === 777) {
      const p = parseOsc777(result.payload);
      if (!p) return;
      parsed = p;
    } else {
      parsed = parseOsc99(result.payload);
    }

    client.send({
      type: "notification_add",
      source: { kind: "terminal", panelId: terminalId, worktreePath },
      title: parsed.title,
      body: parsed.body,
      urgency: parsed.urgency,
    });
  });
}
