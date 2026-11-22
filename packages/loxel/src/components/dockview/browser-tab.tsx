import type { IDockviewPanelHeaderProps } from "dockview-react";
import { HatGlassesIcon, LoaderIcon } from "lucide-react";

import type { BrowserPanelParams } from "@/components/browser/BrowserPanel";
import { Favicon } from "@/components/browser/Favicon";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { NotificationDot } from "@/components/ui/notification-dot";
import { createBrowser } from "@/lib/panel-creators";
import { focusRegisteredPanel } from "@/lib/panel-focus";
import {
  INCOGNITO_TAB_TITLE,
  useIncognitoTab,
  useIsBrowserPageLoading,
} from "@/store/browser-pages";

import { Tab, usePanelTitle } from "./tab";
import { usePanelNotificationDot } from "./use-panel-notification-dot";

export function BrowserTab(props: IDockviewPanelHeaderProps<BrowserPanelParams>) {
  const panelTitle = usePanelTitle(props.api);
  const showDot = usePanelNotificationDot(props, props.api.id);
  const isLoading = useIsBrowserPageLoading(props.api.id);
  // An incognito tab's page, kept in memory instead of the params and title saved with the layout.
  const incognito = props.params.incognito === true;
  const incognitoTab = useIncognitoTab(props.api.id);
  const page = incognito
    ? { url: incognitoTab?.url, faviconUrl: incognitoTab?.faviconUrl }
    : { url: props.params.url, faviconUrl: props.params.faviconUrl };
  const title = incognito ? incognitoTab?.title || INCOGNITO_TAB_TITLE : panelTitle || "Browser";

  const contextMenuItems = (
    <ContextMenuItem onClick={() => createBrowser(page.url, { incognito })}>
      Duplicate
    </ContextMenuItem>
  );

  return (
    <Tab
      api={props.api}
      icon={
        <span className="relative flex shrink-0 items-center gap-0.5">
          {incognito && (
            <HatGlassesIcon aria-label="Incognito" className="text-incognito size-3.5 shrink-0" />
          )}
          {/* The panel's params, which dockview keeps up to date: its parameter change events carry
              only the keys that changed. */}
          {isLoading ? (
            <LoaderIcon
              aria-label="Loading"
              className="text-muted-foreground size-3.5 shrink-0 animate-spin"
            />
          ) : (
            <Favicon url={page.faviconUrl} pageUrl={page.url} incognito={incognito} />
          )}
          {showDot && <NotificationDot />}
        </span>
      }
      title={title}
      contextMenuItems={contextMenuItems}
      // Clicking the already-active tab fires no activation, and leaves focus on the tab header,
      // outside the panel: the page's shortcuts would stop applying.
      onClick={() => focusRegisteredPanel(props.api.id)}
    />
  );
}
