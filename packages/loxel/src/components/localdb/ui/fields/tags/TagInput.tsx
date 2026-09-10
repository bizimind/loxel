import type React from "react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";

import type { FieldViewProps, FieldEditProps } from "../field-props.ts";
import { EmptyValue } from "../field-ui.tsx";

export function TagsView({ value }: FieldViewProps<string[]>) {
  const tags = value ?? [];
  if (tags.length === 0) return <EmptyValue />;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <Tag key={tag} label={tag} />
      ))}
    </span>
  );
}

export function TagInput({ value, onChange, disabled }: FieldEditProps<string[]>) {
  const tags = value ?? [];
  const [input, setInput] = useState("");

  function addTag(tag: string) {
    const trimmed = tag.trim();
    if (!trimmed || tags.includes(trimmed)) return;
    onChange([...tags, trimmed]);
  }

  function removeTag(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(input);
      setInput("");
    } else if (e.key === "Backspace" && input === "") {
      const last = tags[tags.length - 1];
      if (last) removeTag(last);
    }
  }

  return (
    <div className="border-input flex min-h-9 flex-wrap gap-1 rounded-md border bg-[var(--surface-2)] p-1">
      {tags.map((tag) => (
        <Tag key={tag} label={tag} onRemove={disabled ? undefined : () => removeTag(tag)} />
      ))}
      {!disabled && (
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (input) {
              addTag(input);
              setInput("");
            }
          }}
          placeholder={tags.length === 0 ? "Add tag…" : ""}
          className="text-foreground placeholder:text-muted-foreground min-w-20 flex-1 border-0 bg-transparent text-xs outline-none"
        />
      )}
    </div>
  );
}

function Tag({ label, onRemove }: { label: string; onRemove?: () => void }) {
  return (
    <Badge variant="outline" className="h-6 gap-1 px-2 py-0.5 text-[0.85em]">
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="cursor-pointer leading-none text-inherit"
          aria-label={`Remove ${label}`}
        >
          ×
        </button>
      )}
    </Badge>
  );
}
