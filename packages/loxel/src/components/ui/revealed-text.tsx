import { revealUnseen } from "@/lib/unseen-chars";

/** `text` with each character that would not show spelled as a highlighted escape. */
export function RevealedText({ text }: { text: string }) {
  return revealUnseen(text).map((run, i) =>
    run.unseen ? (
      <span key={i} className="bg-warning/20 text-warning rounded-sm px-0.5">
        {run.text}
      </span>
    ) : (
      run.text
    ),
  );
}
