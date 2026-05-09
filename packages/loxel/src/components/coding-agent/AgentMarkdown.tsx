/**
 * Markdown renderer for coding agent responses.
 * Richer styling than CommentMarkdown.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function AgentMarkdown({ content }: { content: string }) {
  return (
    <div className="text-foreground/80 max-w-none text-sm leading-relaxed break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, node }) {
            const codeString = String(children).replace(/\n$/, "");
            const isBlock = !!className || (node?.position && codeString.includes("\n"));

            if (isBlock) {
              return (
                <code className="block rounded bg-[var(--color-editor-surface)] px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                  {children}
                </code>
              );
            }
            return (
              <code className="bg-muted rounded px-1 py-0.5 font-mono text-sm">{children}</code>
            );
          },
          pre({ children }) {
            return <div className="my-2 overflow-x-auto">{children}</div>;
          },
          a({ children, href }) {
            return (
              <a
                href={href}
                className="text-primary hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                {children}
              </a>
            );
          },
          p({ children }) {
            return <p className="my-1.5">{children}</p>;
          },
          ul({ children }) {
            return <ul className="my-1.5 list-disc pl-5">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="my-1.5 list-decimal pl-5">{children}</ol>;
          },
          li({ children }) {
            return <li className="my-1">{children}</li>;
          },
          h1({ children }) {
            return <h1 className="text-foreground mt-3 mb-2 text-lg font-bold">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="text-foreground mt-3 mb-2 text-base font-bold">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="text-foreground mt-2 mb-1.5 text-sm font-bold">{children}</h3>;
          },
          strong({ children }) {
            return <strong className="text-foreground font-semibold">{children}</strong>;
          },
          blockquote({ children }) {
            return (
              <blockquote className="border-muted-foreground my-2 border-l-2 pl-3 italic">
                {children}
              </blockquote>
            );
          },
          table({ children }) {
            return (
              <div className="my-3 overflow-x-auto">
                <table className="min-w-full text-sm">{children}</table>
              </div>
            );
          },
          thead({ children }) {
            return <thead className="border-border border-b">{children}</thead>;
          },
          tbody({ children }) {
            return <tbody className="divide-border divide-y">{children}</tbody>;
          },
          th({ children }) {
            return (
              <th className="text-foreground px-3 py-2 text-left text-sm font-semibold">
                {children}
              </th>
            );
          },
          td({ children }) {
            return <td className="px-3 py-2">{children}</td>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
