/**
 * Lightweight markdown renderer for comment bodies.
 * Uses react-markdown with remark-gfm, styled for compact comment panels.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function CommentMarkdown({ content }: { content: string }) {
  return (
    <div className="text-foreground max-w-none text-xs leading-relaxed break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, node }) {
            const isBlock = !!className || (node?.position && String(children).includes("\n"));
            if (isBlock) {
              return (
                <code className="block font-mono text-[11px] whitespace-pre-wrap">{children}</code>
              );
            }
            return (
              <code className="bg-muted ring-border rounded px-1 py-0.5 font-mono text-[11px] ring-1 ring-inset dark:ring-0">
                {children}
              </code>
            );
          },
          pre({ children }) {
            return <div className="bg-muted my-1 overflow-x-auto rounded p-2">{children}</div>;
          },
          a({ children, href }) {
            return (
              <a
                href={href}
                className="text-link hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                {children}
              </a>
            );
          },
          p({ children }) {
            return <p className="my-1 first:mt-0 last:mb-0">{children}</p>;
          },
          ul({ children }) {
            return <ul className="my-1 list-disc pl-4">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="my-1 list-decimal pl-4">{children}</ol>;
          },
          li({ children }) {
            return <li className="my-0.5">{children}</li>;
          },
          h1({ children }) {
            return <h1 className="text-foreground mt-2 mb-1 text-sm font-bold">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="text-foreground mt-2 mb-1 text-sm font-bold">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="text-foreground mt-1.5 mb-0.5 text-xs font-bold">{children}</h3>;
          },
          strong({ children }) {
            return <strong className="text-foreground font-semibold">{children}</strong>;
          },
          blockquote({ children }) {
            return (
              <blockquote className="border-muted-foreground my-1 border-l-2 pl-2 italic">
                {children}
              </blockquote>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** Inline markdown a preview keeps; everything else is unwrapped to its text. */
const PREVIEW_ELEMENTS = ["p", "code", "em", "strong", "del"];

/**
 * One-paragraph preview of a comment body: markdown is rendered inline (emphasis and code keep
 * their style, blocks and links flatten to text) so a clamped preview never shows raw syntax.
 */
export function CommentPreview({ content, className }: { content: string; className?: string }) {
  return (
    <p className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={PREVIEW_ELEMENTS}
        unwrapDisallowed
        components={{
          p({ children }) {
            return <>{children} </>;
          },
          code({ children }) {
            return (
              <code className="bg-muted ring-border rounded px-0.5 font-mono text-[10px] whitespace-nowrap ring-1 ring-inset dark:ring-0">
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </p>
  );
}
