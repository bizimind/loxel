import { useState } from "react";

export function EditableCell({
  value,
  displayValue,
  onChange,
  placeholder,
}: {
  value: string;
  displayValue?: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <input
        autoFocus
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") setEditing(false);
        }}
        className="border-input bg-background h-6 truncate rounded border px-1.5 text-xs"
        placeholder={placeholder}
      />
    );
  }

  return (
    <button onClick={() => setEditing(true)} className="text-foreground truncate text-left text-xs">
      {displayValue ??
        (value || <span className="text-muted-foreground italic">{placeholder}</span>)}
    </button>
  );
}
