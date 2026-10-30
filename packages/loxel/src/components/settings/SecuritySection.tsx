import { Trash2Icon } from "lucide-react";

import * as api from "@/api/client";
import { Switch } from "@/components/ui/switch";
import { showToast } from "@/components/ui/toast";
import { useSchemaConsentStore } from "@/store/schema-consent";

function reportFailure(err: unknown): void {
  showToast(`Could not save your choice: ${err instanceof Error ? err.message : String(err)}`);
}

function SchemaUrlRow({ url, trusted }: { url: string; trusted: boolean }) {
  return (
    <div className="group grid grid-cols-[1fr_60px_28px] items-center gap-2 px-3 py-0.5">
      <span className="text-foreground truncate text-xs" title={url}>
        {url}
      </span>
      <span className="text-muted-foreground text-[10px]">{trusted ? "Trusted" : "Denied"}</span>
      <button
        aria-label={`Forget ${url}`}
        onClick={() => {
          api.decideSchemaConsent(url, null).catch(reportFailure);
        }}
        className="text-muted-foreground hover:text-destructive flex size-7 items-center justify-center rounded p-1 opacity-0 transition-colors group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Trash2Icon className="size-3.5" />
      </button>
    </div>
  );
}

export function SecuritySection() {
  const trusted = useSchemaConsentStore((s) => s.trusted);
  const denied = useSchemaConsentStore((s) => s.denied);
  const neverFetch = useSchemaConsentStore((s) => s.neverFetch);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-foreground text-sm font-medium">Security</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Files in a project can name a schema to download: a JSON file&apos;s $schema, a YAML
          modeline, a TOML #:schema comment, or an XML schema or DTD. Loxel asks before downloading
          one. Your choices apply right away, to every project. Schemas in Settings &gt; Schemas are
          your own choice and are not affected.
        </p>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-md bg-[var(--surface-2)] px-3 py-2">
        <div>
          <div className="text-foreground text-xs">Never fetch schemas named by files</div>
          <div className="text-muted-foreground text-[10px]">
            No prompts, and trusted addresses below are not downloaded either.
          </div>
        </div>
        <Switch
          checked={neverFetch}
          aria-label="Never fetch schemas named by files"
          onCheckedChange={(checked) => {
            api.setSchemaNeverFetch(checked).catch(reportFailure);
          }}
        />
      </div>

      <div className="divide-border/50 divide-y rounded-md bg-[var(--surface-2)]">
        <div className="text-muted-foreground grid grid-cols-[1fr_60px_28px] items-center gap-2 px-3 py-1.5 text-[10px] font-medium tracking-wider uppercase">
          <span>Schema address</span>
          <span>Choice</span>
          <span />
        </div>
        {trusted.length === 0 && denied.length === 0 ? (
          <div className="text-muted-foreground px-3 py-2 text-xs">No choices yet.</div>
        ) : null}
        {trusted.map((url) => (
          <SchemaUrlRow key={url} url={url} trusted />
        ))}
        {denied.map((url) => (
          <SchemaUrlRow key={url} url={url} trusted={false} />
        ))}
      </div>
    </div>
  );
}
