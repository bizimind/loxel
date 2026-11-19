import { AppWindowIcon, NetworkIcon } from "lucide-react";

import type { SiteAccessRequest, SitePermissionAnswer } from "@/electron/site-permission-protocol";

import { hostOf } from "./BrowserBookmarks";
import { SitePermissionBar } from "./SitePermissionBar";

/** What the site asks for, after its name. */
function asks({ access }: SiteAccessRequest): string {
  if (access.kind === "local-network") {
    return "wants to connect to apps and devices on this Mac and your local network";
  }
  return access.app ? `wants to open ${access.app}` : `wants to open a ${access.scheme}: link`;
}

/**
 * A site asks to open a link in another app (the launch waits), or to reach this Mac or the local
 * network (its requests wait).
 */
export function SiteAccessBar({
  request,
  onAnswer,
}: {
  request: SiteAccessRequest;
  onAnswer: (answer: SitePermissionAnswer) => void;
}) {
  return (
    <SitePermissionBar
      icon={request.access.kind === "local-network" ? NetworkIcon : AppWindowIcon}
      onAllow={() => onAnswer("allow")}
      onAllowOnce={() => onAnswer("allow-once")}
      onBlock={() => onAnswer("block")}
      onDismiss={() => onAnswer("dismiss")}
    >
      <span className="font-medium">{hostOf(request.access.origin)}</span> {asks(request)}
    </SitePermissionBar>
  );
}
