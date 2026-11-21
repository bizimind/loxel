import { type RevealOptions, replaceUnseen, revealUnseen } from "@/lib/unseen-chars";

/** Look of an unseen character's escape; `unseen-char` lets a context restyle it. */
const UNSEEN_CHIP_CLASS = "unseen-char bg-warning/20 text-warning rounded-sm px-0.5";

/** `text` with each character that would not show spelled as a highlighted escape. */
export function RevealedText({ text, ...options }: { text: string } & RevealOptions) {
  return revealUnseen(text, options).map((run, i) =>
    run.unseen ? (
      <span key={i} className={UNSEEN_CHIP_CLASS}>
        {run.text}
      </span>
    ) : (
      run.text
    ),
  );
}

/**
 * `html` (highlighted code, whose markup holds no source text in attributes) with each unseen
 * character spelled as an escape styled like `RevealedText`'s. Tabs and carriage returns stay.
 */
export function revealUnseenInHtml(html: string): string {
  return replaceUnseen(html, (escape) => `<span class="${UNSEEN_CHIP_CLASS}">${escape}</span>`, {
    keepWhitespace: true,
  });
}
