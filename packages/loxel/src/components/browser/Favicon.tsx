import { GlobeIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

/** A page's favicon, or a globe while it has none or it fails to load. */
export function Favicon({ url, className }: { url: string | undefined; className?: string }) {
  // The URL that failed, so a new URL gets its own try.
  const [failedUrl, setFailedUrl] = useState<string>();
  if (!url || url === failedUrl) {
    return <GlobeIcon className={cn("size-3.5 shrink-0", className)} />;
  }
  return (
    <img
      src={url}
      alt=""
      // Loxel's window, not the page, loads it: the site has no business seeing Loxel's address.
      referrerPolicy="no-referrer"
      className={cn("size-3.5 shrink-0", className)}
      onError={() => setFailedUrl(url)}
    />
  );
}
