import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { useSettingsHydrated } from "@/hooks/useSettingsHydrated";
import { frontendLog } from "@/lib/frontend-logger";
import {
  QUIT_ANSWER_LABELS,
  type QuitAnswer,
  type QuitQuestion,
  QuitQuestionSchema,
} from "@/lib/quit-terminals";
import { useSettingsStore } from "@/store/settings-store";

import { BusyTerminalList } from "./BusyTerminalList";

const log = frontendLog.child("ui");

/**
 * The question Electron main asks in this window before a quit that would end terminals running
 * programs (see docs/SHARED_SERVER.md#server-lifecycle), and the "When quitting Loxel" setting that main
 * follows, reported to it whenever it changes. Mount once, at the app root.
 */
export function QuitQuestionHost() {
  const [question, setQuestion] = useState<QuitQuestion | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const hydrated = useSettingsHydrated();
  const whenQuitting = useSettingsStore((s) => s.terminal.whenQuitting);

  useEffect(() => {
    if (hydrated) window.electronAPI?.setWhenQuitting(whenQuitting);
  }, [hydrated, whenQuitting]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    return api.onQuitQuestion((raw) => {
      const parsed = QuitQuestionSchema.safeParse(raw);
      if (!parsed.success) {
        log.warn("Ignoring a malformed quit question", { error: parsed.error });
        return;
      }
      setQuestion(parsed.data);
      setDontAskAgain(false);
      // Main shows the question natively instead if it does not hear this soon.
      api.quitQuestionShown(parsed.data.id);
    });
  }, []);

  useEffect(() => {
    if (!question) return;
    requestAnimationFrame(() => keepRef.current?.focus());
  }, [question]);

  const answer = (choice: QuitAnswer) => {
    if (!question) return;
    if (dontAskAgain && choice !== "cancel") {
      useSettingsStore.getState().updateTerminal({ whenQuitting: choice });
    }
    setQuestion(null);
    window.electronAPI?.answerQuitQuestion({ id: question.id, answer: choice });
  };

  const confirmation = question?.confirmation;
  return (
    <DialogShell open={question !== null} onCancel={() => answer("cancel")} className="w-[26rem]">
      <div className="px-4 pt-4 pb-2">
        <h3 className="text-foreground text-sm font-medium">{confirmation?.title}</h3>
        <div className="text-muted-foreground mt-1 space-y-2 text-xs leading-relaxed">
          <p>{confirmation?.message}</p>
          {confirmation && confirmation.busy.length > 0 && (
            <BusyTerminalList busy={confirmation.busy} />
          )}
        </div>
        <label className="mt-3 flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(e) => setDontAskAgain(e.target.checked)}
            className="accent-primary size-3.5 rounded"
          />
          <span className="text-muted-foreground text-xs">Don&apos;t ask again</span>
        </label>
      </div>
      <div className="flex items-center justify-end gap-2 px-4 py-3">
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => answer("cancel")}>
          {QUIT_ANSWER_LABELS.cancel}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="h-7 text-xs"
          onClick={() => answer("end")}
        >
          {QUIT_ANSWER_LABELS.end}
        </Button>
        <Button ref={keepRef} size="sm" className="h-7 text-xs" onClick={() => answer("keep")}>
          {QUIT_ANSWER_LABELS.keep}
        </Button>
      </div>
    </DialogShell>
  );
}
