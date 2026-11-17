import type { IDockviewPanelHeaderProps } from "dockview-react";
import { LoaderIcon } from "lucide-react";

import type { BrowserPanelParams } from "@/components/browser/BrowserPanel";
import { Favicon } from "@/components/browser/Favicon";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { NotificationDot } from "@/components/ui/notification-dot";
import { createBrowser } from "@/lib/panel-creators";
import { focusRegisteredPanel } from "@/lib/panel-focus";
import { useIsBrowserPageLoading } from "@/store/browser-pages";

import { Tab, usePanelTitle } from "./tab";
import { usePanelNotificationDot } from "./use-panel-notification-dot";

export function BrowserTab(props: IDockviewPanelHeaderProps<BrowserPanelParams>) {
  const title = usePanelTitle(props.api);
  const showDot = usePanelNotificationDot(props.api, props.api.id);
  const isLoading = useIsBrowserPageLoading(props.api.id);

  const contextMenuItems = (
    <ContextMenuItem onClick={() => createBrowser(props.params.url)}>Duplicate</ContextMenuItem>
  );

  return (
    <Tab
      api={props.api}
      icon={
        <span className="relative shrink-0">
          {/* The panel's params, which dockview keeps up to date: its parameter change events carry
              only the keys that changed. */}
          {isLoading ? (
            <LoaderIcon
              aria-label="Loading"
              className="text-muted-foreground size-3.5 shrink-0 animate-spin"
            />
          ) : (
            <Favicon url={props.params.faviconUrl} pageUrl={props.params.url} />
          )}
          {showDot && <NotificationDot />}
        </span>
      }
      title={title || "Browser"}
      contextMenuItems={contextMenuItems}
      // Clicking the already-active tab fires no activation, and leaves focus on the tab header,
      // outside the panel: the page's shortcuts would stop applying.
      onClick={() => focusRegisteredPanel(props.api.id)}
    />
  );
}
