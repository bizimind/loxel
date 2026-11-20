import { AppWindowIcon, FileIcon, FolderIcon, NetworkIcon } from "lucide-react";

import type {
  SiteAccess,
  SiteAccessRequest,
  SitePermissionAnswer,
} from "@/electron/site-permission-protocol";

import { hostOf } from "./BrowserBookmarks";
import { SitePermissionBar } from "./SitePermissionBar";

/** What the site asks for, after its name. */
function asks(access: SiteAccess): string {
  switch (access.kind) {
    case "local-network":
      return "wants to connect to apps and devices on this Mac and your local network";
    case "external-app":
      return access.app ? `wants to open ${access.app}` : `wants to open a ${access.scheme}: link`;
    case "file-system": {
      const verb = access.write ? "edit" : "view";
      return access.directory
        ? `wants to ${verb} files in ${access.name}`
        : `wants to ${verb} ${access.name}`;
    }
    default: {
      const _exhaustive: never = access;
      throw new Error(`Unknown site access: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function iconOf(access: SiteAccess) {
  switch (access.kind) {
    case "local-network":
      return NetworkIcon;
    case "external-app":
      return AppWindowIcon;
    case "file-system":
      return access.directory ? FolderIcon : FileIcon;
    default: {
      const _exhaustive: never = access;
      throw new Error(`Unknown site access: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * A site asks to open a link in another app (the launch waits), to reach this Mac or the local
 * network (its requests wait), or to read or write a file or folder the user gave it. File access
 * is never saved: Allow and Block last as long as the page holds the file or folder.
 */
export function SiteAccessBar({
  request,
  onAnswer,
}: {
  request: SiteAccessRequest;
  onAnswer: (answer: SitePermissionAnswer) => void;
}) {
  const { access } = request;
  const once = access.kind === "file-system";
  return (
    <SitePermissionBar
      icon={iconOf(access)}
      onAllow={() => onAnswer(once ? "allow-once" : "allow")}
      onAllowOnce={once ? undefined : () => onAnswer("allow-once")}
      onBlock={() => onAnswer(once ? "dismiss" : "block")}
      onDismiss={() => onAnswer("dismiss")}
    >
      <span className="font-medium">{hostOf(access.origin)}</span> {asks(access)}
    </SitePermissionBar>
  );
}
