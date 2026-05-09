/** Render text with matched indices bolded. */
export function HighlightedLabel({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const matchSet = new Set(indices);
  const parts: Array<{ text: string; bold: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const isBold = matchSet.has(i);
    const start = i;
    while (i < text.length && matchSet.has(i) === isBold) i++;
    parts.push({ text: text.slice(start, i), bold: isBold });
  }
  return (
    <>
      {parts.map((p, idx) =>
        p.bold ? (
          <b key={idx} className="text-foreground">
            {p.text}
          </b>
        ) : (
          <span key={idx} className="text-muted-foreground">
            {p.text}
          </span>
        ),
      )}
    </>
  );
}
