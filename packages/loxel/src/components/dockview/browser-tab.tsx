import type { IDockviewPanelHeaderProps } from "dockview-react";
import { GlobeIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { BrowserPanelParams } from "@/components/browser/BrowserPanel";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { createBrowser } from "@/lib/panel-creators";

import { Tab } from "./tab";

export function BrowserTab(props: IDockviewPanelHeaderProps<BrowserPanelParams>) {
  const [faviconUrl, setFaviconUrl] = useState(props.params.faviconUrl);
  const [faviconError, setFaviconError] = useState(false);

  useEffect(() => {
    const disposable = props.api.onDidParametersChange((params) => {
      const newFavicon = (params as BrowserPanelParams).faviconUrl;
      setFaviconUrl(newFavicon);
      setFaviconError(false);
    });
    return () => disposable.dispose();
  }, [props.api]);

  const icon =
    faviconUrl && !faviconError ? (
      <img
        src={faviconUrl}
        alt=""
        className="size-3.5 shrink-0"
        onError={() => setFaviconError(true)}
      />
    ) : (
      <GlobeIcon className="size-3.5 shrink-0" />
    );

  const contextMenuItems = (
    <ContextMenuItem onClick={() => createBrowser(props.params.url)}>Duplicate</ContextMenuItem>
  );

  return (
    <Tab
      api={props.api}
      icon={icon}
      title={props.api.title || "Browser"}
      contextMenuItems={contextMenuItems}
    />
  );
}
