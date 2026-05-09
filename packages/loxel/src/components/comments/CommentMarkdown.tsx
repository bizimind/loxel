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
              <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">{children}</code>
            );
          },
          pre({ children }) {
            return <div className="bg-muted my-1 overflow-x-auto rounded p-2">{children}</div>;
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
