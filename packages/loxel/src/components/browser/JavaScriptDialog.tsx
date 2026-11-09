import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { JavaScriptDialogRequest } from "@/electron/javascript-dialog-protocol";

import type { JavaScriptDialogAnswer } from "./useJavaScriptDialogs";

interface JavaScriptDialogProps {
  request: JavaScriptDialogRequest;
  /**
   * Take keyboard focus when shown only if it is inside this element (the panel), so a page never
   * takes focus from where the user is working.
   */
  focusScopeRef: RefObject<HTMLElement | null>;
  /** Set to the control that gets focus (the prompt's input, else OK) for panel activation. */
  focusRef: RefObject<HTMLElement | null>;
  onAnswer: (answer: JavaScriptDialogAnswer) => void;
  /** Called when the dialog closes (answered or withdrawn) while it has focus. Keep it stable. */
  onReturnFocus: () => void;
}

/**
 * A page's `alert()` / `confirm()` / `prompt()`, modal over the page area of its browser panel
 * only: the toolbar, other panels and the rest of the window stay usable. Render with
 * `key={request.id}` so each dialog starts with its own input state.
 */
export function JavaScriptDialog({
  request,
  focusScopeRef,
  focusRef,
  onAnswer,
  onReturnFocus,
}: JavaScriptDialogProps) {
  const { type, title, message, defaultValue, canSuppress } = request;
  const [value, setValue] = useState(defaultValue);
  const [suppress, setSuppress] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    const target = inputRef.current ?? okRef.current;
    focusRef.current = target;
    if (focusScopeRef.current?.contains(document.activeElement)) {
      target?.focus();
      // Like browsers, the prompt's default text starts selected.
      inputRef.current?.select();
    }
    return () => {
      focusRef.current = null;
    };
  }, [focusRef, focusScopeRef]);

  // Layout cleanup runs while the dialog is still in the DOM, so focus can be checked.
  useLayoutEffect(() => {
    const form = formRef.current;
    return () => {
      if (form?.contains(document.activeElement)) onReturnFocus();
    };
  }, [onReturnFocus]);

  const close = (accepted: boolean) => onAnswer({ accepted, value, suppress });

  return (
    // The backdrop covers only the page: clicks on it go nowhere, as the page is blocked.
    <div
      className="absolute inset-0 z-20 flex items-start justify-center bg-black/30 p-4 pt-[12%]"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        (inputRef.current ?? okRef.current)?.focus();
      }}
    >
      <form
        ref={formRef}
        role="alertdialog"
        aria-labelledby={titleId}
        aria-describedby={message ? messageId : undefined}
        className="bg-popover text-foreground border-border w-96 max-w-full rounded-lg border shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          close(true);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          e.stopPropagation();
          close(false);
        }}
      >
        <div className="px-4 pt-4 pb-2">
          {/* Wrapped, not truncated: the end of a host name tells look-alike sites apart. */}
          <h3 id={titleId} className="text-foreground text-sm font-medium break-all">
            {title}
          </h3>
          {message && (
            <p
              id={messageId}
              className="text-muted-foreground mt-1 max-h-60 overflow-y-auto text-xs leading-relaxed break-words whitespace-pre-wrap select-text"
            >
              {message}
            </p>
          )}
          {type === "prompt" && (
            <Input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label={message || title}
              spellCheck={false}
              className="mt-3 h-8 text-xs"
            />
          )}
          {canSuppress && (
            <label className="mt-3 flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={suppress}
                onChange={(e) => setSuppress(e.target.checked)}
                className="accent-primary size-3.5 rounded"
              />
              <span className="text-muted-foreground text-xs">
                Don&apos;t allow this page to show more dialogs
              </span>
            </label>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3">
          {type !== "alert" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => close(false)}
            >
              Cancel
            </Button>
          )}
          <Button ref={okRef} type="submit" size="sm" className="h-7 text-xs">
            OK
          </Button>
        </div>
      </form>
    </div>
  );
}
