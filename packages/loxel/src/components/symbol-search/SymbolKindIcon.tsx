import type { LucideIcon } from "lucide-react";
import {
  Asterisk,
  Box,
  Boxes,
  Braces,
  Brackets,
  CircleSlash,
  Component,
  File,
  Hash,
  Key,
  ListOrdered,
  Package,
  Pi,
  Quote,
  SquareFunction,
  Tag,
  ToggleLeft,
  Type,
  Variable,
  Wrench,
  Zap,
} from "lucide-react";
import * as monaco from "monaco-editor";

import { cn } from "@/lib/utils";

const { SymbolKind } = monaco.languages;

// Colors follow VS Code's symbol icons: types orange, callables purple, values blue.
const TYPE = "text-orange-400";
const CALLABLE = "text-purple-400";
const VALUE = "text-sky-400";
const OTHER = "text-muted-foreground";

const KIND_ICONS: Record<monaco.languages.SymbolKind, { icon: LucideIcon; color: string }> = {
  [SymbolKind.File]: { icon: File, color: OTHER },
  [SymbolKind.Module]: { icon: Braces, color: OTHER },
  [SymbolKind.Namespace]: { icon: Braces, color: OTHER },
  [SymbolKind.Package]: { icon: Package, color: OTHER },
  [SymbolKind.Class]: { icon: Box, color: TYPE },
  [SymbolKind.Method]: { icon: SquareFunction, color: CALLABLE },
  [SymbolKind.Property]: { icon: Wrench, color: VALUE },
  [SymbolKind.Field]: { icon: Tag, color: VALUE },
  [SymbolKind.Constructor]: { icon: SquareFunction, color: CALLABLE },
  [SymbolKind.Enum]: { icon: ListOrdered, color: TYPE },
  [SymbolKind.Interface]: { icon: Component, color: VALUE },
  [SymbolKind.Function]: { icon: SquareFunction, color: CALLABLE },
  [SymbolKind.Variable]: { icon: Variable, color: VALUE },
  [SymbolKind.Constant]: { icon: Pi, color: VALUE },
  [SymbolKind.String]: { icon: Quote, color: OTHER },
  [SymbolKind.Number]: { icon: Hash, color: OTHER },
  [SymbolKind.Boolean]: { icon: ToggleLeft, color: OTHER },
  [SymbolKind.Array]: { icon: Brackets, color: OTHER },
  [SymbolKind.Object]: { icon: Braces, color: OTHER },
  [SymbolKind.Key]: { icon: Key, color: OTHER },
  [SymbolKind.Null]: { icon: CircleSlash, color: OTHER },
  [SymbolKind.EnumMember]: { icon: ListOrdered, color: VALUE },
  [SymbolKind.Struct]: { icon: Boxes, color: TYPE },
  [SymbolKind.Event]: { icon: Zap, color: TYPE },
  [SymbolKind.Operator]: { icon: Asterisk, color: OTHER },
  [SymbolKind.TypeParameter]: { icon: Type, color: OTHER },
};

export function SymbolKindIcon({
  kind,
  className,
}: {
  kind: monaco.languages.SymbolKind;
  className?: string;
}) {
  const { icon: Icon, color } = KIND_ICONS[kind];
  const label = SymbolKind[kind];
  return <Icon role="img" aria-label={label} className={cn(color, className)} />;
}
