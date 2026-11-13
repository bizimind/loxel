/**
 * Agent output rendered as read-only markdown, typeset like the markdown editor, with fenced code
 * highlighted by Shiki in the read-only code theme.
 */
import { memo, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import "@/styles/agent-prose.css";
import { highlightCode } from "@/lib/highlighter";
import { dispatchLoxelEvent } from "@/lib/loxel-events";
import { useReadOnlyCodeTheme } from "@/lib/syntax-theme";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/store/ui";

function HighlightedCode({ code, language }: { code: string; language: string }) {
  const darkMode = useUIStore((s) => s.darkMode);
  const { theme, revision } = useReadOnlyCodeTheme(darkMode);
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
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

  // Shiki's output is built from escaped token text (highlightCode), never raw markup.
  if (html === null) return <code>{code}</code>;
  return <code dangerouslySetInnerHTML={{ __html: html }} />;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * An external http(s) URL, or null. Relative and loopback links are refused: inside the app they
 * would open Loxel itself (its server is on loopback), which agent output must not drive.
 */
function externalUrl(href: string | undefined): URL | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost")) return null;
    return url;
  } catch {
    return null;
  }
}

/** Like terminal links: Cmd+click opens a browser panel, a click the system browser. */
function openLink(event: React.MouseEvent, href: string | undefined) {
  event.preventDefault();
  if (!externalUrl(href) || !href) return;
  if (event.metaKey) dispatchLoxelEvent("loxel-create-browser", { url: href });
  else window.open(href);
}

function textOf(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

const components: Components = {
  pre({ children }) {
    return <pre>{children}</pre>;
  },
  code({ className, children }) {
    const language = /language-([\w+#.-]+)/.exec(className ?? "")?.[1];
    const text = textOf(children);
    if (!language && !text.includes("\n")) return <code>{children}</code>;
    return <HighlightedCode code={text.replace(/\n$/, "")} language={language ?? "text"} />;
  },
  a({ children, href }) {
    return (
      <a href={href} onClick={(event) => openLink(event, href)}>
        {children}
      </a>
    );
  },
  // Images are never fetched: a prompt-injected agent could leak data in an image URL just by
  // printing it. They show as text, and a link the user can choose to open.
  img({ src, alt }) {
    const href = typeof src === "string" ? src : undefined;
    const label = `[image${alt ? `: ${alt}` : ""}]`;
    if (!externalUrl(href)) return <span>{label}</span>;
    return (
      <a href={href} onClick={(event) => openLink(event, href)}>
        {label}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="agent-table-wrap">
        <table>{children}</table>
      </div>
    );
  },
};

export const AgentMarkdown = memo(function AgentMarkdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={cn("agent-prose", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
