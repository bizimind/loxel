import { type LucideIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

/** The look of the bars under a browser panel's toolbar. */
export const PANEL_BAR_CLASS =
  "border-border bg-muted/40 flex shrink-0 items-center gap-2 border-b px-3 py-1";

/**
 * A site asks for a permission: a bar under the browser panel's toolbar, which leaves the page
 * usable (unlike its dialogs), so the user can answer when they like. Allow this time is offered
 * when `onAllowOnce` is given; the close button is Not now.
 */
export function SitePermissionBar({
  icon: Icon,
  children,
  onAllow,
  onAllowOnce,
  onBlock,
  onDismiss,
}: {
  icon: LucideIcon;
  /** What the site asks for, as a sentence. */
  children: ReactNode;
  onAllow: () => void;
  onAllowOnce?: () => void;
  onBlock: () => void;
  onDismiss: () => void;
}) {
  return (
    <div role="alert" className={PANEL_BAR_CLASS}>
      <Icon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="text-foreground min-w-0 flex-1 truncate text-xs">{children}</span>
      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={onBlock}>
        Block
      </Button>
      {onAllowOnce && (
        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={onAllowOnce}>
          Allow this time
        </Button>
      )}
      <Button size="sm" className="h-6 text-xs" onClick={onAllow}>
        Allow
      </Button>
      <button
        title="Not now"
        aria-label="Not now"
        className="text-muted-foreground hover:text-foreground rounded p-0.5"
        onClick={onDismiss}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
