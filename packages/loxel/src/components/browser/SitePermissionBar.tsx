import { type LucideIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

/** The look of the bars under a browser panel's toolbar. */
export const PANEL_BAR_CLASS =
  "border-border bg-muted/40 flex shrink-0 items-center gap-2 border-b px-3 py-1";

/**
 * How long a bar's answer buttons stay off after the request it shows changes, as Chrome's prompts
 * do, so a click meant for what the bar said a moment ago can't answer what it says now.
 */
export const ANSWER_GUARD_MS = 500;

/** Whether the request `requestKey` names has been shown for `ANSWER_GUARD_MS`. */
function useAnswerable(requestKey: string): boolean {
  const [answerableKey, setAnswerableKey] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setAnswerableKey(requestKey), ANSWER_GUARD_MS);
    return () => clearTimeout(timer);
  }, [requestKey]);
  return answerableKey === requestKey;
}

/**
 * A site asks for a permission: a bar under the browser panel's toolbar, which leaves the page
 * usable (unlike its dialogs), so the user can answer when they like. Allow this time is offered
 * when `onAllowOnce` is given; the close button is Not now. Whenever the request it shows changes
 * (`requestKey`), its answer buttons are off for a moment (`ANSWER_GUARD_MS`); Not now, which only
 * refuses, never is.
 */
export function SitePermissionBar({
  requestKey,
  icon: Icon,
  children,
  onAllow,
  onAllowOnce,
  onBlock,
  onDismiss,
}: {
  /** Names the request shown, and changes with anything the bar says about it. */
  requestKey: string;
  icon: LucideIcon;
  /** What the site asks for, as a sentence. */
  children: ReactNode;
  onAllow: () => void;
  onAllowOnce?: () => void;
  onBlock: () => void;
  onDismiss: () => void;
}) {
  const answerable = useAnswerable(requestKey);
  return (
    <div role="alert" className={PANEL_BAR_CLASS}>
      <Icon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="text-foreground min-w-0 flex-1 truncate text-xs">{children}</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 text-xs"
        disabled={!answerable}
        onClick={onBlock}
      >
        Block
      </Button>
      {onAllowOnce && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          disabled={!answerable}
          onClick={onAllowOnce}
        >
          Allow this time
        </Button>
      )}
      <Button size="sm" className="h-6 text-xs" disabled={!answerable} onClick={onAllow}>
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
