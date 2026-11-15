import type { IDockviewPanelHeaderProps } from "dockview-react";
import { useEffect, useState } from "react";

import type { BrowserPanelParams } from "@/components/browser/BrowserPanel";
import { Favicon } from "@/components/browser/Favicon";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { NotificationDot } from "@/components/ui/notification-dot";
import { createBrowser } from "@/lib/panel-creators";
import { focusRegisteredPanel } from "@/lib/panel-focus";

import { Tab, usePanelTitle } from "./tab";
import { usePanelNotificationDot } from "./use-panel-notification-dot";

export function BrowserTab(props: IDockviewPanelHeaderProps<BrowserPanelParams>) {
  const [faviconUrl, setFaviconUrl] = useState(props.params.faviconUrl);
  const title = usePanelTitle(props.api);
  const showDot = usePanelNotificationDot(props.api, props.api.id);

  useEffect(() => {
    const disposable = props.api.onDidParametersChange((params) => {
      const newFavicon = (params as BrowserPanelParams).faviconUrl;
      setFaviconUrl(newFavicon);
    });
    return () => disposable.dispose();
  }, [props.api]);

  const contextMenuItems = (
    <ContextMenuItem onClick={() => createBrowser(props.params.url)}>Duplicate</ContextMenuItem>
  );

  return (
    <Tab
      api={props.api}
      icon={
        <span className="relative shrink-0">
          <Favicon url={faviconUrl} />
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
