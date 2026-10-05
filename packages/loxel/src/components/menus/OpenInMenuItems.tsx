import { useQuery } from "@tanstack/react-query";
import { AppWindowIcon, FolderOpenIcon } from "lucide-react";
import { Fragment } from "react";

import { getOpenInAppIconUrl, getOpenInApps, openWithApp, revealInFinder } from "@/api/client";
import type { OpenInApp } from "@/api/open-in-model";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { showToast } from "@/components/ui/toast";
import { queryKeys } from "@/queries/query-keys";

/**
 * "Open In" uses macOS LaunchServices on the server, which always runs on the user's own
 * machine, so the browser's platform is the server's platform.
 */
export const isOpenInSupported = navigator.userAgent.includes("Macintosh");

/** Matches the server's per-file-type app list cache. */
const APP_LIST_STALE_TIME_MS = 60_000;

function showActionError(action: string, err: unknown) {
  showToast(`${action}: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * Context menu items for a file or folder on disk: "Reveal in Finder", plus an "Open In"
 * submenu (the apps macOS offers for a file; installed terminals and editors for a folder).
 * Renders nothing outside macOS. `disabled` greys both out, e.g. for a path not on disk.
 */
export function OpenInMenuItems({ path, disabled = false }: { path: string; disabled?: boolean }) {
  if (!isOpenInSupported) return null;

  return (
    <>
      <ContextMenuItem
        disabled={disabled}
        onClick={() => {
          revealInFinder({ path }).catch((err: unknown) =>
            showActionError("Couldn't reveal in Finder", err),
          );
        }}
      >
        <FolderOpenIcon />
        Reveal in Finder
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={disabled}>
          <AppWindowIcon />
          Open In
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <OpenInAppList path={path} />
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}

/** Mounted only while the submenu is open, so the app list is fetched on demand. */
function OpenInAppList({ path }: { path: string }) {
  const { data, error, isPending } = useQuery({
    queryKey: queryKeys.openInApps(path),
    queryFn: () => getOpenInApps(path),
    staleTime: APP_LIST_STALE_TIME_MS,
  });

  if (isPending) return <ContextMenuItem disabled>Loading apps…</ContextMenuItem>;
  if (error) return <ContextMenuItem disabled>Couldn't load apps</ContextMenuItem>;
  if (!data.defaultApp && data.apps.length === 0) {
    return <ContextMenuItem disabled>No apps found</ContextMenuItem>;
  }

  return (
    <>
      {data.defaultApp && <OpenInAppItem path={path} app={data.defaultApp} isDefault />}
      {data.defaultApp && data.apps.length > 0 && <ContextMenuSeparator />}
      {data.apps.map((app, i) => (
        <Fragment key={app.path}>
          {/* Folder apps are grouped: a separator between terminals and editors */}
          {i > 0 && app.group !== data.apps[i - 1]!.group && <ContextMenuSeparator />}
          <OpenInAppItem path={path} app={app} />
        </Fragment>
      ))}
    </>
  );
}

function OpenInAppItem({
  path,
  app,
  isDefault = false,
}: {
  path: string;
  app: OpenInApp;
  isDefault?: boolean;
}) {
  return (
    <ContextMenuItem
      title={app.path}
      onClick={() => {
        openWithApp({ path, appPath: app.path }).catch((err: unknown) =>
          showActionError(`Couldn't open in ${app.name}`, err),
        );
      }}
    >
      <img
        src={getOpenInAppIconUrl(app.path)}
        alt=""
        draggable={false}
        className="size-4 shrink-0"
        onError={(event) => {
          event.currentTarget.style.visibility = "hidden";
        }}
      />
      {app.name}
      {isDefault && <span className="text-muted-foreground ml-auto pl-4">default</span>}
    </ContextMenuItem>
  );
}
