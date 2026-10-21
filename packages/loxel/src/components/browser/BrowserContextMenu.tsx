import type { ContextMenuEvent, WebviewTag } from "electron";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ClipboardPasteIcon,
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  ImageIcon,
  LinkIcon,
  PanelTopOpenIcon,
  RefreshCwIcon,
  ScissorsIcon,
  SearchCodeIcon,
  SearchIcon,
  TextSelectIcon,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { copyToClipboard } from "@/lib/clipboard";
import { openBrowserTab } from "@/lib/panel-creators";
import { isHttpUrl } from "@/url-utils";

import { webSearchUrl } from "./web-search";

type WebviewContextMenuParams = ContextMenuEvent["params"];

/** A right-click inside a browser panel's page. */
export interface BrowserContextMenuState {
  open: boolean;
  /** The webview that was right-clicked. */
  webview: WebviewTag;
  params: WebviewContextMenuParams;
  /**
   * The page's history at the right-click. Read once there: the webview's `canGoBack` and
   * `canGoForward` are synchronous IPC, too slow for every render of the panel.
   */
  canGoBack: boolean;
  canGoForward: boolean;
}

interface BrowserContextMenuProps {
  menu: BrowserContextMenuState;
  /** The browser panel hosting the webview; new tabs open next to it. */
  panelId: string;
  onOpenChange: (open: boolean) => void;
}

/** Longest selection quoted in the "Search the Web" item before it is cut off. */
const SEARCH_LABEL_MAX_LENGTH = 30;
/** Longest selection searched for, keeping the search URL well within URL length limits. */
const SEARCH_QUERY_MAX_LENGTH = 500;

/**
 * The first `max` code points of `text`. Slicing UTF-16 units could split a surrogate pair (an
 * emoji), and `encodeURIComponent` throws on the lone half.
 */
function firstCodePoints(text: string, max: number): string {
  // A code point is at most two UTF-16 units, so this prefix holds at least `max` of them.
  return Array.from(text.slice(0, max * 2))
    .slice(0, max)
    .join("");
}

function quoteSelection(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const quoted = firstCodePoints(oneLine, SEARCH_LABEL_MAX_LENGTH);
  return quoted.length < oneLine.length ? `${quoted}…` : oneLine;
}

/**
 * The browser panel's page context menu, built like a browser's from what was right-clicked: a
 * link, an image, selected text or an editable field, or else the page itself.
 */
export function BrowserContextMenu({ menu, panelId, onOpenChange }: BrowserContextMenuProps) {
  const { webview, params } = menu;
  const { linkURL, srcURL, selectionText, isEditable, editFlags } = params;
  const isImage = params.mediaType === "image" && srcURL !== "";
  const searchQuery = firstCodePoints(selectionText.trim(), SEARCH_QUERY_MAX_LENGTH);
  const searchText = quoteSelection(searchQuery);
  const copyImage = window.electronAPI?.copyWebviewImage;

  const openTab = (url: string, activate = false) =>
    openBrowserTab(url, { sourcePanelId: panelId, activate });
  // Editing commands act on the page's focused element, so give the page focus back first.
  const edit = (command: "cut" | "copy" | "paste" | "selectAll") => () => {
    webview.focus();
    webview[command]();
  };

  const groups: { id: string; items: ReactNode }[] = [];

  if (linkURL) {
    groups.push({
      id: "link",
      items: (
        <>
          {isHttpUrl(linkURL) && (
            <>
              <ContextMenuItem onClick={() => openTab(linkURL)}>
                <PanelTopOpenIcon />
                Open Link in New Tab
              </ContextMenuItem>
              <ContextMenuItem onClick={() => window.open(linkURL)}>
                <ExternalLinkIcon />
                Open Link in External Browser
              </ContextMenuItem>
            </>
          )}
          <ContextMenuItem onClick={() => copyToClipboard(linkURL, "link address")}>
            <LinkIcon />
            Copy Link Address
          </ContextMenuItem>
        </>
      ),
    });
  }

  if (isImage) {
    groups.push({
      id: "image",
      items: (
        <>
          {isHttpUrl(srcURL) && (
            <ContextMenuItem onClick={() => openTab(srcURL)}>
              <ImageIcon />
              Open Image in New Tab
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={() => webview.downloadURL(srcURL)}>
            <DownloadIcon />
            Save Image As…
          </ContextMenuItem>
          {params.hasImageContents && copyImage && (
            <ContextMenuItem
              onClick={() => copyImage(webview.getWebContentsId(), params.x, params.y)}
            >
              <CopyIcon />
              Copy Image
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={() => copyToClipboard(srcURL, "image address")}>
            <LinkIcon />
            Copy Image Address
          </ContextMenuItem>
        </>
      ),
    });
  }

  if (isEditable || searchText) {
    groups.push({
      id: "text",
      items: (
        <>
          {isEditable && (
            <ContextMenuItem disabled={!editFlags.canCut} onClick={edit("cut")}>
              <ScissorsIcon />
              Cut
            </ContextMenuItem>
          )}
          {(isEditable || selectionText) && (
            <ContextMenuItem disabled={!editFlags.canCopy} onClick={edit("copy")}>
              <CopyIcon />
              Copy
            </ContextMenuItem>
          )}
          {isEditable && (
            <>
              <ContextMenuItem disabled={!editFlags.canPaste} onClick={edit("paste")}>
                <ClipboardPasteIcon />
                Paste
              </ContextMenuItem>
              <ContextMenuItem disabled={!editFlags.canSelectAll} onClick={edit("selectAll")}>
                <TextSelectIcon />
                Select All
              </ContextMenuItem>
            </>
          )}
          {searchText && (
            <ContextMenuItem onClick={() => openTab(webSearchUrl(searchQuery), true)}>
              <SearchIcon />
              Search the Web for “{searchText}”
            </ContextMenuItem>
          )}
        </>
      ),
    });
  }

  // Page actions only when nothing more specific was right-clicked, as in a browser.
  if (groups.length === 0) {
    groups.push({
      id: "page",
      items: (
        <>
          <ContextMenuItem disabled={!menu.canGoBack} onClick={() => webview.goBack()}>
            <ArrowLeftIcon />
            Back
          </ContextMenuItem>
          <ContextMenuItem disabled={!menu.canGoForward} onClick={() => webview.goForward()}>
            <ArrowRightIcon />
            Forward
          </ContextMenuItem>
          <ContextMenuItem onClick={() => webview.reload()}>
            <RefreshCwIcon />
            Reload
          </ContextMenuItem>
        </>
      ),
    });
    if (isHttpUrl(params.pageURL)) {
      groups.push({
        id: "source",
        items: (
          <ContextMenuItem onClick={() => openTab(`view-source:${params.pageURL}`, true)}>
            <CodeIcon />
            View Page Source
          </ContextMenuItem>
        ),
      });
    }
  }

  groups.push({
    id: "inspect",
    items: (
      <ContextMenuItem onClick={() => webview.inspectElement(params.x, params.y)}>
        <SearchCodeIcon />
        Inspect Element
      </ContextMenuItem>
    ),
  });

  // `params.x`/`y` are window coordinates in device-independent pixels, not relative to the
  // webview; app zoom (Cmd+/Cmd-) scales CSS pixels, so divide by it to get client coordinates.
  const zoom = window.electronAPI?.getZoomFactor?.() ?? 1;
  const position = { x: params.x / zoom, y: params.y / zoom };

  return (
    <ContextMenu open={menu.open} onOpenChange={onOpenChange} position={position}>
      {groups.map(({ id, items }, i) => (
        <Fragment key={id}>
          {i > 0 && <ContextMenuSeparator />}
          {items}
        </Fragment>
      ))}
    </ContextMenu>
  );
}
