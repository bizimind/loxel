/**
 * The prompt box, one surface with the session's controls in its footer. Enter sends; while the
 * agent works, Enter queues the message for after the turn and Cmd+Enter steers the running turn
 * with it. A leading `/` opens the agent's live command list (built-ins, skills, plugin and
 * project commands), navigable with the arrows (wrapping), Home/End and Page Up/Down. Pasted
 * images are attached.
 */
import { ArrowUpIcon, ImageIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  type AgentCommand,
  type AgentImage,
  MAX_IMAGE_BASE64_LENGTH,
} from "@/api/agent-session-model";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const IMAGE_TYPES = new Set<AgentImage["mediaType"]>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function isImageType(type: string): type is AgentImage["mediaType"] {
  return (IMAGE_TYPES as Set<string>).has(type);
}

async function readImage(file: File): Promise<AgentImage | null> {
  if (!isImageType(file.type)) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { mediaType: file.type, data: btoa(binary) };
}

/** Commands matching what follows the `/`, while the first word is still being typed. */
export function matchingCommands(text: string, commands: readonly AgentCommand[]): AgentCommand[] {
  const match = /^\/(\S*)$/.exec(text);
  if (!match) return [];
  const query = match[1]!.toLowerCase();
  return commands
    .filter((c) => c.name.toLowerCase().includes(query))
    .toSorted((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(query) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(query) ? 0 : 1;
      return aStarts - bStarts || a.name.localeCompare(b.name);
    });
}

/** Rows a Page Up or Page Down moves in the command list. */
const PAGE_ROWS = 8;

/** The highlighted row after a navigation key, wrapping at the ends; null for other keys. */
export function nextHighlight(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "PageDown":
      return Math.min(current + PAGE_ROWS, count - 1);
    case "PageUp":
      return Math.max(current - PAGE_ROWS, 0);
    default:
      return null;
  }
}

function CommandMenu({
  matches,
  highlight,
  onHighlight,
  onPick,
}: {
  matches: readonly AgentCommand[];
  highlight: number;
  onHighlight: (index: number) => void;
  onPick: (command: AgentCommand) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // Keep the highlighted row in view as the keys move it.
  useEffect(() => {
    const row = listRef.current?.children[highlight];
    if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
  }, [highlight, matches]);

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Commands and skills"
      className="border-border bg-popover absolute right-0 bottom-full left-0 z-10 mb-2 max-h-72 overflow-y-auto rounded-xl border p-1 shadow-lg"
    >
      {matches.map((command, i) => (
        <button
          key={command.name}
          type="button"
          role="option"
          aria-selected={i === highlight}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(command);
          }}
          onMouseMove={() => onHighlight(i)}
          className={cn(
            "flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
            i === highlight && "bg-foreground/[0.07]",
          )}
        >
          <span className="text-foreground shrink-0 font-mono text-[12px]">/{command.name}</span>
          {command.argumentHint && (
            <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
              {command.argumentHint}
            </span>
          )}
          <span className="text-muted-foreground truncate text-[12px]">{command.description}</span>
        </button>
      ))}
    </div>
  );
}

export function AgentComposer({
  commands,
  working,
  disabled,
  controls,
  onSend,
  onInterrupt,
  textareaRef,
}: {
  commands: readonly AgentCommand[];
  working: boolean;
  disabled: boolean;
  /** The session's controls (model, effort, mode), in the footer. */
  controls: React.ReactNode;
  /** False when it could not be sent; the composer then keeps the text. */
  onSend: (text: string, images: AgentImage[], delivery: "queue" | "steer") => boolean;
  onInterrupt: () => void;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<AgentImage[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [tooLarge, setTooLarge] = useState(false);
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = textareaRef ?? ownRef;
  const matches = useMemo(() => matchingCommands(text, commands), [text, commands]);
  const menuOpen = matches.length > 0;
  const canSend = !disabled && (text.trim() !== "" || images.length > 0);

  const submit = (delivery: "queue" | "steer") => {
    if (!canSend || !onSend(text.trim(), images, delivery)) return;
    setText("");
    setImages([]);
  };

  const complete = (command: AgentCommand) => {
    setText(`/${command.name} `);
    setHighlight(0);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      const next = nextHighlight(e.key, Math.min(highlight, matches.length - 1), matches.length);
      if (next !== null) {
        e.preventDefault();
        setHighlight(next);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setText("");
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.metaKey)) {
        const command = matches[Math.min(highlight, matches.length - 1)];
        // Enter on a fully typed command runs it; otherwise it completes the name.
        if (command && !(e.key === "Enter" && text === `/${command.name}`)) {
          e.preventDefault();
          complete(command);
          return;
        }
      }
    }
    if (e.key === "Escape" && working) {
      e.preventDefault();
      onInterrupt();
      return;
    }
    // Enter that confirms an input method's composition is not a send.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit(e.metaKey || e.ctrlKey ? "steer" : "queue");
    }
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => isImageType(f.type));
    if (files.length === 0) return;
    e.preventDefault();
    const read = (await Promise.all(files.map(readImage))).filter(
      (image): image is AgentImage => image !== null,
    );
    const fitting = read.filter((image) => image.data.length <= MAX_IMAGE_BASE64_LENGTH);
    setTooLarge(fitting.length < read.length);
    setImages((prev) => [...prev, ...fitting]);
  };

  return (
    <div className="relative">
      {menuOpen && (
        <CommandMenu
          matches={matches}
          highlight={Math.min(highlight, matches.length - 1)}
          onHighlight={setHighlight}
          onPick={complete}
        />
      )}
      <div className="border-border bg-background focus-within:border-ring/60 rounded-xl border shadow-sm transition-colors">
        {(images.length > 0 || tooLarge) && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5">
            {images.map((image, i) => (
              <span
                key={i}
                className="bg-foreground/[0.06] text-muted-foreground flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]"
              >
                <ImageIcon className="size-3" /> Image {i + 1}
                <button
                  type="button"
                  aria-label="Remove image"
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            ))}
            {tooLarge && (
              <span className="text-destructive text-[11px]">An image over 5 MB was left out.</span>
            )}
          </div>
        )}
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setHighlight(0);
            setTooLarge(false);
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => void onPaste(e)}
          disabled={disabled}
          rows={Math.min(10, Math.max(2, text.split("\n").length))}
          placeholder={
            working
              ? "Add to the queue, or ⌘Enter to steer this turn"
              : "Ask Claude, or type / for commands and skills"
          }
          className="placeholder:text-muted-foreground block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[14px] leading-relaxed outline-none disabled:opacity-60"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">{controls}</div>
          {working && (
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={onInterrupt}
              title="Stop (Esc)"
              aria-label="Stop"
            >
              <SquareIcon className="fill-current" />
            </Button>
          )}
          <Button
            size="icon-xs"
            disabled={!canSend}
            onClick={() => submit("queue")}
            title={working ? "Queue (Enter)" : "Send (Enter)"}
            aria-label={working ? "Queue" : "Send"}
            className="rounded-lg"
          >
            <ArrowUpIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}
