/**
 * The prompt box. Enter sends; while the agent works, Enter queues the message for after the turn
 * and Cmd+Enter steers the running turn with it. A leading `/` opens the agent's live command
 * list (built-ins, skills, plugin and project commands). Pasted images are attached.
 */
import { ImageIcon, SendIcon, SquareIcon, XIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

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
    })
    .slice(0, 12);
}

export function AgentComposer({
  commands,
  working,
  disabled,
  onSend,
  onInterrupt,
}: {
  commands: readonly AgentCommand[];
  working: boolean;
  disabled: boolean;
  /** False when it could not be sent; the composer then keeps the text. */
  onSend: (text: string, images: AgentImage[], delivery: "queue" | "steer") => boolean;
  onInterrupt: () => void;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<AgentImage[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [tooLarge, setTooLarge] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const matches = useMemo(() => matchingCommands(text, commands), [text, commands]);
  const menuOpen = matches.length > 0;

  const submit = (delivery: "queue" | "steer") => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || disabled) return;
    if (!onSend(trimmed, images, delivery)) return;
    setText("");
    setImages([]);
  };

  const complete = (command: AgentCommand) => {
    setText(`/${command.name} `);
    setHighlight(0);
    textareaRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setHighlight((h) => (h + step + matches.length) % matches.length);
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
        <div
          role="listbox"
          className="border-border bg-popover absolute right-0 bottom-full left-0 mb-1.5 max-h-72 overflow-y-auto rounded-md border p-1 shadow-lg"
        >
          {matches.map((command, i) => (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => {
                e.preventDefault();
                complete(command);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                "flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-xs",
                i === highlight && "bg-muted",
              )}
            >
              <span className="text-foreground shrink-0 font-mono">/{command.name}</span>
              {command.argumentHint && (
                <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                  {command.argumentHint}
                </span>
              )}
              <span className="text-muted-foreground truncate">{command.description}</span>
            </button>
          ))}
        </div>
      )}
      {tooLarge && (
        <p className="text-destructive mb-1 text-[11px]">An image over 5 MB was left out.</p>
      )}
      <div className="border-border bg-background focus-within:border-ring rounded-lg border">
        {images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2.5 pt-2">
            {images.map((image, i) => (
              <span
                key={i}
                className="bg-muted text-muted-foreground flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]"
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
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setHighlight(0);
            setTooLarge(false);
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => void onPaste(e)}
          disabled={disabled}
          rows={Math.min(8, Math.max(2, text.split("\n").length))}
          placeholder={
            working
              ? "Enter queues for after this turn · ⌘Enter steers it now · Esc interrupts"
              : "Ask Claude, or type / for commands and skills"
          }
          className="placeholder:text-muted-foreground block w-full resize-none bg-transparent px-3 py-2 text-[14px] leading-relaxed outline-none disabled:opacity-60"
        />
        <div className="flex items-center justify-end gap-1.5 px-2 pb-2">
          {working && (
            <Button size="xs" variant="outline" onClick={onInterrupt} title="Interrupt (Esc)">
              <SquareIcon /> Stop
            </Button>
          )}
          <Button
            size="xs"
            disabled={disabled || (!text.trim() && images.length === 0)}
            onClick={() => submit("queue")}
          >
            <SendIcon /> {working ? "Queue" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}
