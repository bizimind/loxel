/**
 * Pure parsers that extract structured payload from raw OSC notification data.
 *
 * Each parser accepts the `data` string that xterm.js provides to OSC handlers
 * (everything after the `N;` prefix) and returns a unified payload shape.
 */
import type { ServerNotification } from "@/api/notification-model";

export interface OscPayload {
  title?: string;
  body?: string;
  urgency: ServerNotification["urgency"];
}

/** OSC 9 (iTerm2): entire payload is a text message. */
export function parseOsc9(data: string): OscPayload {
  return { body: data || undefined, urgency: "normal" };
}

/**
 * OSC 777 (rxvt-unicode): `notify;title;body`
 * The `data` from xterm starts after `777;`, so it arrives as `notify;title;body`.
 */
export function parseOsc777(data: string): OscPayload | null {
  if (!data.startsWith("notify;")) return null;
  const rest = data.slice(7); // strip "notify;"
  const semi = rest.indexOf(";");
  if (semi === -1) {
    return { title: rest || undefined, urgency: "normal" };
  }
  return {
    title: rest.slice(0, semi) || undefined,
    body: rest.slice(semi + 1) || undefined,
    urgency: "normal",
  };
}

const URGENCY_MAP: Record<string, OscPayload["urgency"]> = {
  "0": "low",
  "1": "normal",
  "2": "high",
  "3": "critical",
};

/**
 * OSC 99 (Kitty): `key=value:key=value;payload`
 *
 * Parameters before the first `;`:
 *   i=  — notification identifier
 *   p=  — payload type: "title" or "body" (default: "title")
 *   e=  — urgency: 0=low, 1=normal, 2=high, 3=critical
 *   d=  — done flag: 0=more data coming, 1=complete
 *
 * For simplicity, we treat each OSC 99 sequence as a standalone notification.
 * Multi-part notifications (d=0 followed by d=1) are not coalesced in v1.
 */
export function parseOsc99(data: string): OscPayload {
  const semi = data.indexOf(";");
  if (semi === -1) {
    return { body: data || undefined, urgency: "normal" };
  }

  const paramStr = data.slice(0, semi);
  const payload = data.slice(semi + 1);

  let payloadType = "title";
  let urgency: OscPayload["urgency"] = "normal";

  for (const part of paramStr.split(":")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const val = part.slice(eq + 1);
    if (key === "p") payloadType = val;
    else if (key === "e") urgency = URGENCY_MAP[val] ?? "normal";
  }

  const result: OscPayload = { urgency };
  if (payloadType === "body") {
    result.body = payload || undefined;
  } else {
    result.title = payload || undefined;
  }
  return result;
}
