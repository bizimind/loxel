/** The app update's state, kept by Electron main and shown in Settings > General. */
export type UpdateState =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; releasedAt: string }
  | { state: "downloading"; version: string; percent: number }
  | { state: "ready"; version: string }
  | { state: "installing" }
  | { state: "error"; message: string };
