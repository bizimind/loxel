/** The app update's state, kept by Electron main and shown in Settings > General. */
export type UpdateState =
  | { state: "idle" }
  | { state: "checking" }
  | {
      state: "available";
      version: string;
      releasedAt: string;
      restartsTerminals: RestartsTerminals;
    }
  | { state: "downloading"; version: string; percent: number; restartsTerminals: RestartsTerminals }
  | { state: "ready"; version: string; restartsTerminals: RestartsTerminals }
  | { state: "installing" }
  | { state: "error"; message: string };

/**
 * Whether installing an update ends the running terminals: `true` when its terminal host protocol
 * has another major version than the running hosts', which its server cannot talk to; `"unknown"`
 * when its release does not say which protocol it speaks.
 */
export type RestartsTerminals = boolean | "unknown";
