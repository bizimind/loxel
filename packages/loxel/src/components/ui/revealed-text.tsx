import { type RevealOptions, type TextRun, revealUnseen } from "@/lib/unseen-chars";

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
 * `html`, the highlighted markup of the source text `runs` came from, with the escapes of `runs`
 * in place of the characters they stand for, styled like `RevealedRuns`'. What to reveal is
 * decided on the source, never on the markup, whose tags can split the text around a character.
 * Tags are skipped, and an entity (`&lt;`) stands for one source character.
 */
export function revealUnseenInHtml(html: string, runs: TextRun[]): string {
  const escapes = new Map<number, TextRun>();
  let offset = 0;
  for (const run of runs) {
    if (run.unseen) escapes.set(offset, run);
    offset += run.length;
  }
  if (escapes.size === 0) return html;

  let result = "";
  let source = 0;
  let i = 0;
  while (i < html.length) {
    const char = html[i]!;
    if (char === "<") {
      const stop = html.indexOf(">", i) + 1 || html.length;
      result += html.slice(i, stop);
      i = stop;
      continue;
    }
    const run = escapes.get(source);
    if (run) {
      result += `<span class="${UNSEEN_CHIP_CLASS}">${run.text}</span>`;
      i += run.length;
      source += run.length;
      continue;
    }
    const stop = char === "&" ? html.indexOf(";", i) + 1 || i + 1 : i + 1;
    result += html.slice(i, stop);
    i = stop;
    source += 1;
  }
  return result;
}
