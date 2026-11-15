/**
 * Render text with matched indices bolded. Unmatched text from `emphasizeFrom` on (a path's file
 * name) keeps the body color and a medium weight in light mode, so the name stands out from its
 * muted directory.
 */
export function HighlightedLabel({
  text,
  indices,
  emphasizeFrom = text.length,
}: {
  text: string;
  indices: number[];
  emphasizeFrom?: number;
}) {
  if (indices.length === 0) return <>{text}</>;
  const matchSet = new Set(indices);
  const parts: Array<{ text: string; bold: boolean; emphasized: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const isBold = matchSet.has(i);
    const emphasized = i >= emphasizeFrom;
    const start = i;
    while (i < text.length && matchSet.has(i) === isBold && i >= emphasizeFrom === emphasized) i++;
    parts.push({ text: text.slice(start, i), bold: isBold, emphasized });
  }
  return (
    <>
      {parts.map((p, idx) => {
        if (p.bold) {
          // Light: the accent blue deepened a little, so matches keep contrast on the selected row
          return (
            <b
              key={idx}
              className="dark:text-foreground text-[color-mix(in_srgb,var(--link)_82%,var(--foreground))]"
            >
              {p.text}
            </b>
          );
        }
        return (
          <span
            key={idx}
            className={
              p.emphasized
                ? "text-foreground dark:text-muted-foreground not-dark:font-medium"
                : "text-muted-foreground"
            }
          >
            {p.text}
          </span>
        );
      })}
    </>
  );
}
