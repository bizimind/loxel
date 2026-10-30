import { useCallback } from "react";
import { createPortal } from "react-dom";

import * as api from "@/api/client";
import { Button } from "@/components/ui/button";
import { showToast } from "@/components/ui/toast";
import { useSchemaConsentStore } from "@/store/schema-consent";

export function reportFailure(err: unknown): void {
  showToast(`Could not save your choice: ${err instanceof Error ? err.message : String(err)}`);
}

/** Asks about the first schema URL waiting for a decision, in every window, until one answers. */
export function SchemaConsentPrompt() {
  const url = useSchemaConsentStore((s) => s.pending[0]);
  const waiting = useSchemaConsentStore((s) => s.pending.length);

  const decide = useCallback(
    (decision: "trust" | "deny") => {
      if (url) api.decideSchemaConsent(url, decision).catch(reportFailure);
    },
    [url],
  );

  if (!url) return null;

  return createPortal(
    <div
      role="alertdialog"
      aria-label="Download schema?"
      className="animate-in slide-in-from-bottom-2 fade-in bg-popover border-border fixed bottom-4 left-4 z-[9998] flex w-96 max-w-[calc(100%-2rem)] flex-col gap-2 rounded-lg border px-3 py-2.5 shadow-lg"
    >
      <span className="text-foreground text-xs font-medium">
        Download this schema?{waiting > 1 ? ` (1 of ${waiting})` : ""}
      </span>
      <span className="text-muted-foreground text-xs">
        A file in this project, or a schema it uses, names a schema at this address. Loxel downloads
        it only if you allow it. The file works without it, without schema checks and completions.
      </span>
      <code className="text-foreground bg-muted max-h-24 overflow-y-auto rounded px-1.5 py-1 text-[11px] break-all">
        {url}
      </code>
      <div className="flex justify-end gap-1.5">
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            api.setSchemaNeverFetch(true).catch(reportFailure);
          }}
        >
          Never ask
        </Button>
        <Button variant="outline" size="xs" onClick={() => decide("deny")}>
          Don&apos;t fetch
        </Button>
        <Button size="xs" onClick={() => decide("trust")}>
          Allow
        </Button>
      </div>
    </div>,
    document.body,
  );
}
