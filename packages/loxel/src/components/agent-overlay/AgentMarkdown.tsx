import "@/styles/agent-overlay.css";
import { memo, useEffect, useState } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { highlightCode } from "@/lib/highlighter";
import { openWebLink } from "@/lib/open-link";
import { useReadOnlyCodeTheme } from "@/lib/syntax-theme";
import { useUIStore } from "@/store/ui";

/** A fenced block highlighted with the read-only code theme diffs and logs use. */
export function CodeBlock({ code, language }: { code: string; language: string | null }) {
  const darkMode = useUIStore((s) => s.darkMode);
  const { theme, revision } = useReadOnlyCodeTheme(darkMode);
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!language) return;
    let cancelled = false;
    highlightCode(code, language, theme)
      .then((lines) => {
        if (!cancelled) setHtml(lines.map((line) => line.html).join("\n"));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [code, language, theme, revision]);

  return (
    <div className="agent-code">
      {language && <div className="agent-code-label">{language}</div>}
      {html === null ? (
        <pre>{code}</pre>
      ) : (
        // Shiki escapes the code; the spans only carry colors.
        // oxlint-disable-next-line react/no-danger
        <pre dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/iu;

/**
 * Links in agent output open only on the web: a relative link or a loopback one would load the
 * Loxel server (or another local service) in a window, from text the user did not write.
 */
function isExternalWebLink(href: string): boolean {
  try {
    const url = new URL(href);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !LOOPBACK_HOST.test(url.hostname)
    );
  } catch {
    return false;
  }
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const language = /language-([\w+-]+)/u.exec(className ?? "")?.[1] ?? null;
    const text = String(children ?? "");
    // Inline code has no language and no newline.
    if (!language && !text.includes("\n")) return <code>{children}</code>;
    return <CodeBlock code={text.replace(/\n$/u, "")} language={language} />;
  },
  // Never loaded: an image URL an agent writes (or a prompt injection makes it write) would be
  // fetched without a click, carrying whatever it encodes. Shown as its text instead.
  img: ({ alt, src }) => <span className="text-muted-foreground">[image: {alt || src}]</span>,
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (href && isExternalWebLink(href)) openWebLink(event, href);
      }}
    >
      {children}
    </a>
  ),
};

/** An agent's markdown, in the markdown editor's typography. */
export const AgentMarkdown = memo(function AgentMarkdown({ text }: { text: string }) {
  return (
    <div className="agent-prose">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
});
