import { frontendLog } from "@/lib/frontend-logger";

/** Writes `text` to the system clipboard, logging a failure; `what` names the value in the log. */
export function copyToClipboard(text: string, what: string) {
  navigator.clipboard.writeText(text).catch((err: unknown) => {
    frontendLog
      .child("ui")
      .error(`Failed to copy ${what} to clipboard`, {
        error: err instanceof Error ? err : undefined,
      });
  });
}
