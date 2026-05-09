import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircleIcon,
  CheckCircleIcon,
  DownloadIcon,
  LoaderIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback } from "react";

import type { UpdateState } from "@/api/update-model";

import * as api from "@/api/client";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { queryKeys } from "@/queries/query-keys";
import { useSettingsStore } from "@/store/settings-store";

export function GeneralSection() {
  const queryClient = useQueryClient();
  const autoReveal = useSettingsStore((s) => s.autoRevealInExplorer);
  const setAutoReveal = useSettingsStore((s) => s.setAutoRevealInExplorer);

  const { data: versionData } = useQuery({
    queryKey: queryKeys.version(),
    queryFn: api.getVersion,
    staleTime: Infinity,
  });

  const { data: status } = useQuery({
    queryKey: queryKeys.updateStatus(),
    queryFn: api.getUpdateStatus,
    staleTime: 30_000,
  });

  const state = status?.state ?? "idle";

  const handleCheck = useCallback(async () => {
    try {
      const result = await api.checkForUpdate();
      queryClient.setQueryData(queryKeys.updateStatus(), result);
    } catch {
      queryClient.setQueryData(queryKeys.updateStatus(), {
        state: "error",
        message: "Failed to check for updates",
      } satisfies UpdateState);
    }
  }, [queryClient]);

  const handleDownload = useCallback(async () => {
    try {
      const result = await api.downloadUpdate();
      queryClient.setQueryData(queryKeys.updateStatus(), result);
    } catch {
      queryClient.setQueryData(queryKeys.updateStatus(), {
        state: "error",
        message: "Failed to download update",
      } satisfies UpdateState);
    }
  }, [queryClient]);

  const handleInstall = useCallback(async () => {
    try {
      await api.installUpdate();
    } catch {
      queryClient.setQueryData(queryKeys.updateStatus(), {
        state: "error",
        message: "Failed to install update",
      } satisfies UpdateState);
    }
  }, [queryClient]);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-foreground text-sm font-medium">General</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Version {versionData?.version ?? "..."} {versionData?.isDev ? "(dev)" : ""}
        </p>
      </div>

      <div className="space-y-3">
        <UpdateStatusDisplay status={status} />

        <div className="flex items-center gap-2">
          {(state === "idle" || state === "error" || state === "ready") && (
            <Button variant="outline" size="xs" onClick={handleCheck}>
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
            <Button variant="outline" size="xs" onClick={handleDownload}>
              <DownloadIcon className="mr-1.5 size-3" />
              Download update
            </Button>
          )}

          {state === "downloading" && (
            <Button variant="outline" size="xs" disabled>
              <LoaderIcon className="mr-1.5 size-3 animate-spin" />
              Downloading...
            </Button>
          )}

          {state === "ready" && (
            <Button size="xs" onClick={handleInstall}>
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
      </div>

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

function UpdateStatusDisplay({ status }: { status: UpdateState | undefined }) {
  if (!status || status.state === "idle") return null;

  if (status.state === "error") {
    return (
      <div className="text-destructive flex items-center gap-2 text-xs">
        <AlertCircleIcon className="size-3.5 shrink-0" />
        <span>{status.message}</span>
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
