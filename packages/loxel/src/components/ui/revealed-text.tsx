import { type RevealOptions, type TextRun, replaceUnseen, revealUnseen } from "@/lib/unseen-chars";

/** Look of an unseen character's escape; `unseen-char` lets a context restyle it. */
const UNSEEN_CHIP_CLASS = "unseen-char bg-warning/20 text-warning rounded-sm px-0.5";

/** Runs from `revealUnseen`, each unseen character's escape highlighted. */
export function RevealedRuns({ runs }: { runs: TextRun[] }) {
  return runs.map((run, i) =>
    run.unseen ? (
      <span key={i} className={UNSEEN_CHIP_CLASS}>
        {run.text}
      </span>
    ) : (
      run.text
    ),
  );
}

/** `text` with each character that would not show spelled as a highlighted escape. */
export function RevealedText({ text, ...options }: { text: string } & RevealOptions) {
  return <RevealedRuns runs={revealUnseen(text, options)} />;
}

/**
 * `html` (highlighted code, whose markup holds no source text in attributes) with each unseen
 * character spelled as an escape styled like `RevealedText`'s, treating it as content.
 */
export function revealUnseenInHtml(html: string): string {
  return replaceUnseen(html, (escape) => `<span class="${UNSEEN_CHIP_CLASS}">${escape}</span>`, {
    content: true,
  });
}
