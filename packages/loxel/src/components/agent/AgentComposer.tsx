/**
 * The agent panel's message box: Enter sends (while the agent works, it steers the current turn,
 * or queues for after it), Shift+Enter adds a line, Escape interrupts, `/` opens the agent's live
 * list of slash commands and skills, and pasted images are attached.
 */
import { ArrowUpIcon, ImageIcon, SquareIcon, XIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { AgentCommand, AgentDelivery, AgentImage } from "@/api/agent-session-model";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const IMAGE_TYPES = new Set<AgentImage["mediaType"]>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function isImageType(type: string): type is AgentImage["mediaType"] {
  return IMAGE_TYPES.has(type as AgentImage["mediaType"]);
}

function readImage(file: File): Promise<AgentImage | null> {
  if (!isImageType(file.type)) return Promise.resolve(null);
  const mediaType = file.type;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const data = url.slice(url.indexOf(",") + 1);
      resolve(data ? { mediaType, data } : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

const MAX_MENU_ITEMS = 50;

export function AgentComposer({
  commands,
  working,
  disabled,
  onSend,
  onInterrupt,
}: {
  commands: AgentCommand[];
  working: boolean;
  disabled: boolean;
  onSend: (text: string, images: AgentImage[], delivery: AgentDelivery) => void;
  onInterrupt: () => void;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<AgentImage[]>([]);
  const [delivery, setDelivery] = useState<AgentDelivery>("steer");
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The slash menu shows while the first word is a `/command` being typed.
  const slashQuery = /^\/(\S*)$/.exec(text)?.[1];
  const matches = useMemo(() => {
    if (slashQuery === undefined) return [];
    const query = slashQuery.toLowerCase();
    return commands
      .filter((c) => c.name.toLowerCase().includes(query))
      .sort((a, b) => Number(!a.name.startsWith(query)) - Number(!b.name.startsWith(query)))
      .slice(0, MAX_MENU_ITEMS);
  }, [commands, slashQuery]);
  const menuOpen = matches.length > 0 && !menuDismissed;

  const submit = () => {
    if (disabled) return;
    // Sent as typed: leading indentation matters in pasted code.
    if (!text.trim() && images.length === 0) return;
    onSend(text.replace(/\s+$/, ""), images, working ? delivery : "queue");
    setText("");
    setImages([]);
  };

  const complete = (command: AgentCommand) => {
    setText(`/${command.name} `);
    setMenuDismissed(true);
    textareaRef.current?.focus();
  };

  return (
    <div className="border-border bg-background relative rounded-lg border shadow-sm">
      {menuOpen && (
        <div className="border-border bg-popover absolute right-0 bottom-full left-0 mb-1 max-h-72 overflow-auto rounded-md border py-1 shadow-md">
          {matches.map((command, index) => (
            <button
              key={command.name}
              type="button"
              className={cn(
                "flex w-full items-baseline gap-2 px-3 py-1 text-left text-xs",
                index === menuIndex ? "bg-primary text-foreground" : "hover:bg-muted",
              )}
              onMouseEnter={() => setMenuIndex(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                complete(command);
              }}
            >
              <span className="text-foreground shrink-0 font-mono">/{command.name}</span>
              {command.argumentHint && (
                <span className="text-muted-foreground shrink-0 font-mono">
                  {command.argumentHint}
                </span>
              )}
              <span className="text-muted-foreground truncate">{command.description}</span>
            </button>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2">
          {images.map((image, index) => (
            <span
              key={index}
              className="bg-muted text-muted-foreground flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]"
            >
              <ImageIcon className="size-3" />
              Image {index + 1}
              <button
                type="button"
                aria-label="Remove image"
                onClick={() => setImages((list) => list.filter((_, i) => i !== index))}
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        rows={Math.min(10, Math.max(2, text.split("\n").length))}
        className="text-foreground placeholder:text-muted-foreground w-full resize-none bg-transparent px-3 py-2.5 text-[length:var(--loxel-font-prose-size)] leading-relaxed outline-none"
        placeholder={
          disabled
            ? "The agent is not running"
            : working
              ? "Message Claude while it works…"
              : "Message Claude, or type / for commands and skills"
        }
        value={text}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
          setMenuIndex(0);
          setMenuDismissed(false);
        }}
        onPaste={(event) => {
          const files = [...event.clipboardData.files].filter((f) => isImageType(f.type));
          if (files.length === 0) return;
          event.preventDefault();
          void Promise.all(files.map(readImage)).then((read) =>
            setImages((list) => [...list, ...read.filter((i): i is AgentImage => i !== null)]),
          );
        }}
        onKeyDown={(event) => {
          if (menuOpen) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setMenuIndex((i) => (i + step + matches.length) % matches.length);
              return;
            }
            if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
              const command = matches[menuIndex];
              // Enter on an exact match sends it; otherwise it completes the selection.
              if (event.key === "Tab" || command?.name !== slashQuery) {
                event.preventDefault();
                if (command) complete(command);
                return;
              }
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setMenuDismissed(true);
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
            return;
          }
          if (event.key === "Escape" && working) {
            event.preventDefault();
            onInterrupt();
          }
        }}
      />
      <div className="flex items-center gap-2 px-2 pb-2">
        {working && (
          <div className="border-border flex overflow-hidden rounded border text-[11px]">
            {(["steer", "queue"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                title={
                  mode === "steer"
                    ? "Reach Claude at its next step, in this turn"
                    : "Wait until this turn ends"
                }
                className={cn(
                  "px-1.5 py-0.5",
                  delivery === mode ? "bg-muted text-foreground" : "text-muted-foreground",
                )}
                onClick={() => setDelivery(mode)}
              >
                {mode === "steer" ? "Steer" : "Queue"}
              </button>
            ))}
          </div>
        )}
        <span className="text-muted-foreground ml-auto text-[11px]">
          {working ? "Esc to interrupt" : "Shift+Enter for a new line"}
        </span>
        {working && (
          <Button size="icon-xs" variant="outline" title="Interrupt (Esc)" onClick={onInterrupt}>
            <SquareIcon className="size-3" />
          </Button>
        )}
        <Button
          size="icon-xs"
          title="Send (Enter)"
          disabled={disabled || (!text.trim() && images.length === 0)}
          onClick={submit}
        >
          <ArrowUpIcon />
        </Button>
      </div>
    </div>
  );
}
