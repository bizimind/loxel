/** Result of an undo/redo file operation — carries enough info for client-side event dispatch. */
export type FileOperationResult =
  | { type: "rename" | "move"; oldPath: string; newPath: string }
  | { type: "delete"; path: string }
  | { type: "restore"; path: string }
  | { type: "create"; path: string };
