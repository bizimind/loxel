/**
 * Window renderers that subscribed to something main forwards from their webviews' pages (page
 * dialogs, notifications). Pages of a window whose current document hasn't subscribed get the
 * browser's "nothing shown" result instead of waiting on a renderer that isn't handling them.
 */
import type { WebContents } from "electron";

export interface ListeningRenderers {
  /** Subscribe `host`'s current document; valid until that document is replaced. */
  add: (host: WebContents) => void;
  has: (hostId: number) => boolean;
}

export function createListeningRenderers(): ListeningRenderers {
  const listening = new Set<number>();
  return {
    add: (host) => {
      if (listening.has(host.id)) return;
      listening.add(host.id);
      // On commit, not on start: the window cancels navigations it starts (external links are
      // opened in the system browser from will-navigate), and those keep the document. A new
      // document subscribes again. did-navigate fires only for main-frame cross-document commits.
      // A reload keeps the webContents, so both listeners go with the subscription.
      const forget = () => {
        listening.delete(host.id);
        host.off("did-navigate", forget);
        host.off("destroyed", forget);
      };
      host.on("did-navigate", forget);
      host.once("destroyed", forget);
    },
    has: (hostId) => listening.has(hostId),
  };
}
