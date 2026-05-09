/**
 * Reusable component that renders a KeyCombo as inline modifier icons + key label.
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

import type { KeyCombo } from "@/store/keybindings/keybinding-schema";

import { cn } from "@/lib/utils";
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

interface KeyComboDisplayProps {
  combo: KeyCombo;
  className?: string;
}

export function KeyComboDisplay({ combo, className }: KeyComboDisplayProps) {
  const parts = (combo as string).split("+");

  return (
    <span className={cn("inline-flex items-center gap-px", className)}>
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
