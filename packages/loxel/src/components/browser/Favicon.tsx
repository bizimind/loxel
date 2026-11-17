import { GlobeIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import { loadedFavicon, loadsThroughMain, requestFavicon } from "./favicon-loads";

/**
 * What an `<img>` shows for favicon `url` of page `pageUrl`: web URLs as main loads them in the
 * desktop app (`favicon-loads.ts`), anything else as it is. While a new favicon of the same element
 * loads, the one before stays, so a page changing its favicon doesn't flash a globe in between.
 */
function useFaviconSrc(url: string | undefined, pageUrl: string | undefined): string | undefined {
  const viaMain = url !== undefined && loadsThroughMain(url);
  // The favicon this element last showed, null if it failed to load.
  const [shown, setShown] = useState<{ url: string; src: string | null }>();
  // No favicon (a new page) drops the last one, which belongs to the page before.
  if (url === undefined && shown) setShown(undefined);

  useEffect(() => {
    if (url === undefined) return;
    if (!viaMain) return setShown({ url, src: url });
    let current = true;
    const request = requestFavicon(url, pageUrl);
    void request.promise.then((src) => current && setShown({ url, src }));
    return () => {
      current = false;
      request.release();
    };
  }, [url, viaMain, pageUrl]);

  if (url === undefined) return undefined;
  if (!viaMain) return url;
  // Loaded favicons show at once, as when a tab is rebuilt by a worktree switch.
  return loadedFavicon(url, pageUrl) ?? shown?.src ?? undefined;
}

/**
 * A page's favicon, or a globe while it has none or it fails to load. `pageUrl` is the page it
 * belongs to: a favicon of that page's origin loads with the site's cookies.
 */
export function Favicon({
  url,
  pageUrl,
  className,
}: {
  url: string | undefined;
  pageUrl?: string;
  className?: string;
}) {
  const src = useFaviconSrc(url, pageUrl);
  // The source that failed, so a new one gets its own try.
  const [failedSrc, setFailedSrc] = useState<string>();
  if (!src || src === failedSrc) {
    return <GlobeIcon className={cn("size-3.5 shrink-0", className)} />;
  }
  return (
    <img
      src={src}
      alt=""
      // Loxel's window, not the page, loads it: the site has no business seeing Loxel's address.
      referrerPolicy="no-referrer"
      className={cn("size-3.5 shrink-0", className)}
      onError={() => setFailedSrc(src)}
    />
  );
}
