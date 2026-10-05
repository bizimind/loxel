/**
 * Reusable component that renders a KeyBinding as inline modifier icons + key labels. Chord
 * steps are separated by a small gap (e.g. "⌘\  →").
 *
 * Icons are used for modifiers (Cmd, Ctrl, Alt, Shift, Tab, Enter, Backspace, Delete)
 * instead of text. Size and color inherit from the parent font by default
 * (via `1em` sizing and `currentColor`), but can be overridden with `className`.
 */

import type { LucideIcon } from "lucide-react";
import {
  ArrowBigUpIcon,
  ArrowRightToLineIcon,
  ChevronUpIcon,
  CommandIcon,
  CornerDownLeftIcon,
  DeleteIcon,
  OptionIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { KeyBinding, KeyCombo } from "@/store/keybindings/key-combo";
import { getBindingSteps } from "@/store/keybindings/key-combo";
import { KEY_LABELS } from "@/store/keybindings/keybinding-schema";

/** Maps canonical key part names to lucide icons. */
const ICON_MAP: Record<string, LucideIcon> = {
  Cmd: CommandIcon,
  Ctrl: ChevronUpIcon,
  Alt: OptionIcon,
  Shift: ArrowBigUpIcon,
  Tab: ArrowRightToLineIcon,
  Enter: CornerDownLeftIcon,
  Backspace: DeleteIcon,
};

/** Keys whose icon should be horizontally flipped. */
const FLIP_KEYS = new Set(["Backspace"]);

interface KeyBindingDisplayProps {
  binding: KeyBinding;
  className?: string;
}

export function KeyBindingDisplay({ binding, className }: KeyBindingDisplayProps) {
  return (
    <span className={cn("inline-flex items-center gap-[0.4em]", className)}>
      {getBindingSteps(binding).map((step, i) => (
        <KeyComboParts key={i} combo={step} />
      ))}
    </span>
  );
}

function KeyComboParts({ combo }: { combo: KeyCombo }) {
  const parts = (combo as string).split("+");

  return (
    <span className="inline-flex items-center gap-px">
      {parts.map((part, i) => {
        const Icon = ICON_MAP[part];
        if (Icon) {
          return (
            <Icon key={i} className={cn("size-[1em]", FLIP_KEYS.has(part) && "-scale-x-100")} />
          );
        }
        const label = KEY_LABELS[part] ?? part;
        return (
          <span key={i} className="leading-none">
            {label}
          </span>
        );
      })}
    </span>
  );
}
