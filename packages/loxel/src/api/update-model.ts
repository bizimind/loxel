export type UpdateState =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; releasedAt: string }
  | { state: "downloading"; version: string }
  | { state: "ready"; version: string }
  | { state: "installing" }
  | { state: "error"; message: string };
