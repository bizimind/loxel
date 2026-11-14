/**
 * Markdown for agent messages and plans: the editor's prose (agent-transcript.css) with code
 * blocks highlighted by Shiki in the read-only code theme, like the diff and log views.
 */
import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { highlightCode } from "@/lib/highlighter";
import { useReadOnlyCodeTheme } from "@/lib/syntax-theme";
import { useUIStore } from "@/store/ui";

import "@/styles/agent-transcript.css";

function CodeBlock({ code, language }: { code: string; language: string }) {
  const darkMode = useUIStore((s) => s.darkMode);
  const { theme, revision } = useReadOnlyCodeTheme(darkMode);
  const [lines, setLines] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    highlightCode(code, language, theme)
      .then((highlighted) => {
        if (!cancelled) setLines(highlighted.map((line) => line.html));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [code, language, theme, revision]);

  if (!lines) return <code>{code}</code>;
  return (
    <code>
      {lines.map((html, index) => (
        // Shiki escapes token text; the markup is only its color spans.
        <div key={index} dangerouslySetInnerHTML={{ __html: html || " " }} />
      ))}
    </code>
  );
}

/** An absolute http(s) URL to another host than this machine. */
export function isExternalWebUrl(href: string): boolean {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    return !["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname);
  } catch {
    return false;
  }
}

export const AgentMarkdown = memo(function AgentMarkdown({
  text,
  compact = false,
}: {
  text: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "agent-prose agent-prose-compact" : "agent-prose"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children }) {
            const language = /language-(\S+)/.exec(className ?? "")?.[1];
            const code = String(children).replace(/\n$/, "");
            if (!language && !code.includes("\n")) return <code>{children}</code>;
            return <CodeBlock code={code} language={language ?? "text"} />;
          },
          a({ children, href }) {
            // Only absolute web links: a relative or loopback one would open inside Loxel.
            if (!href || !isExternalWebUrl(href)) return <span>{children}</span>;
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
          img({ src, alt }) {
            // Never loaded: an image the agent prints could carry data out in its URL (a prompt
            // injection's exfiltration channel) without a click.
            return (
              <span className="text-muted-foreground font-mono text-[0.85em]">
                [image{alt ? `: ${alt}` : ""}
                {typeof src === "string" && src ? ` ${src}` : ""}]
              </span>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
