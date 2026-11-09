import { RepositoryTrustSettings } from "./RepositoryTrustSettings";
import { SchemaDownloadSettings } from "./SchemaDownloadSettings";

/** Settings > Security: one page, each part of it its own component. */
export function SecuritySection() {
  return (
    <div className="space-y-5">
      <h3 className="text-foreground text-sm font-medium">Security</h3>
      <RepositoryTrustSettings />
      <SchemaDownloadSettings />
    </div>
  );
}
