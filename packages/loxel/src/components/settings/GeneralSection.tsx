import { useQuery } from "@tanstack/react-query";
import {
  AlertCircleIcon,
  CheckCircleIcon,
  DownloadIcon,
  LoaderIcon,
  RefreshCwIcon,
} from "lucide-react";

import * as api from "@/api/client";
import type { UpdateState } from "@/api/update-model";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { queryKeys } from "@/queries/query-keys";
import { useUpdateStatus } from "@/queries/use-update-status";
import { useSettingsStore } from "@/store/settings-store";

/** The site's download page, for installing by hand when an update cannot install itself. */
const DOWNLOAD_PAGE_URL = "https://bizimind.io/download";

export function GeneralSection() {
  const autoReveal = useSettingsStore((s) => s.autoRevealInExplorer);
  const setAutoReveal = useSettingsStore((s) => s.setAutoRevealInExplorer);

  const { data: versionData } = useQuery({
    queryKey: queryKeys.version(),
    queryFn: api.getVersion,
    staleTime: Infinity,
  });

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-foreground text-sm font-medium">General</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Version {versionData?.version ?? "..."} {versionData?.isDev ? "(dev)" : ""}
        </p>
      </div>

      {window.electronAPI && <UpdateControls electronAPI={window.electronAPI} />}

      <div className="space-y-2">
        <h4 className="text-foreground text-xs font-medium">Project Explorer</h4>
        <div className="flex items-center gap-2">
          <span className="text-foreground text-xs">Auto-reveal active file</span>
          <span className="text-muted-foreground text-[10px]">
            (reveal file in tree when switching editor tabs)
          </span>
          <Switch checked={autoReveal} onCheckedChange={setAutoReveal} className="ml-auto" />
        </div>
      </div>
    </div>
  );
}

/** Check, download and install app updates; only the desktop app has them. */
function UpdateControls({ electronAPI }: { electronAPI: NonNullable<Window["electronAPI"]> }) {
  const autoCheck = useSettingsStore((s) => s.autoCheckForUpdates);
  const setAutoCheck = useSettingsStore((s) => s.setAutoCheckForUpdates);
  const status = useUpdateStatus();
  const state = status?.state ?? "idle";

  return (
    <div className="space-y-3">
      <UpdateStatusDisplay status={status} />

      <div className="flex items-center gap-2">
        {(state === "idle" || state === "error") && (
          <Button variant="outline" size="xs" onClick={() => void electronAPI.checkForUpdates()}>
            <RefreshCwIcon className="mr-1.5 size-3" />
            Check for updates
          </Button>
        )}

        {state === "checking" && (
          <Button variant="outline" size="xs" disabled>
            <LoaderIcon className="mr-1.5 size-3 animate-spin" />
            Checking...
          </Button>
        )}

        {state === "available" && (
          <Button variant="outline" size="xs" onClick={() => void electronAPI.downloadUpdate()}>
            <DownloadIcon className="mr-1.5 size-3" />
            Download update
          </Button>
        )}

        {status?.state === "downloading" && (
          <Button variant="outline" size="xs" disabled>
            <LoaderIcon className="mr-1.5 size-3 animate-spin" />
            Downloading... {status.percent}%
          </Button>
        )}

        {state === "ready" && (
          <Button size="xs" onClick={() => electronAPI.installUpdate()}>
            Install & Restart
          </Button>
        )}

        {state === "installing" && (
          <Button size="xs" disabled>
            <LoaderIcon className="mr-1.5 size-3 animate-spin" />
            Restarting...
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-foreground text-xs">Check for updates automatically</span>
        <span className="text-muted-foreground text-[10px]">
          (ask the update server for the latest version when Loxel starts)
        </span>
        <Switch checked={autoCheck} onCheckedChange={setAutoCheck} className="ml-auto" />
      </div>
    </div>
  );
}

function UpdateStatusDisplay({ status }: { status: UpdateState | undefined }) {
  if (!status || status.state === "idle") return null;

  if (status.state === "error") {
    return (
      <div className="text-destructive flex items-center gap-2 text-xs">
        <AlertCircleIcon className="size-3.5 shrink-0" />
        <span>{status.message}</span>
        <a href={DOWNLOAD_PAGE_URL} target="_blank" rel="noreferrer" className="underline">
          Download the latest version
        </a>
      </div>
    );
  }

  if (status.state === "available") {
    return (
      <div className="text-foreground flex items-center gap-2 text-xs">
        <DownloadIcon className="size-3.5 shrink-0" />
        <span>Version {status.version} is available</span>
      </div>
    );
  }

  if (status.state === "ready") {
    return (
      <div className="text-foreground flex items-center gap-2 text-xs">
        <CheckCircleIcon className="size-3.5 shrink-0" />
        <span>Version {status.version} ready to install</span>
      </div>
    );
  }

  return null;
}
