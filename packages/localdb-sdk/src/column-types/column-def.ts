export type PrimitiveKind = "boolean" | "number" | "text";

export type InlineOption = {
  id?: number; // FK to _options.id; populated by SDK after save
  value: string | number;
  label: string;
  color?: string;
  position: number;
};

export type OptionSet =
  | { source: "inline"; items: InlineOption[] }
  | { source: "ref"; table: string; valueColumn: string; labelColumn: string };

export type ColumnDef =
  | {
      kind: "text";
      label: string;
      nullable?: boolean;
      unique?: boolean;
      multi?: boolean;
      maxLength?: number;
      options?: OptionSet;
    }
  | { kind: "longtext"; label: string; nullable?: boolean }
  | { kind: "url"; label: string; nullable?: boolean; unique?: boolean; multi?: boolean }
  | { kind: "color"; label: string; nullable?: boolean; multi?: boolean }
  | {
      kind: "number";
      label: string;
      nullable?: boolean;
      unique?: boolean;
      multi?: boolean;
      min?: number;
      max?: number;
      integer?: boolean;
      options?: OptionSet;
    }
  | { kind: "boolean"; label: string; nullable?: boolean }
  | { kind: "date"; label: string; nullable?: boolean }
  | { kind: "datetime"; label: string; nullable?: boolean }
  | { kind: "duration"; label: string; nullable?: boolean }
  | { kind: "ref"; label: string; nullable?: boolean; targetTable: string; targetColumn: string }
  | { kind: "formula"; label: string; expression: string; resultKind: PrimitiveKind };

export type StoredColumnDef = Exclude<ColumnDef, { kind: "formula" }>;

// Convenience alias used in crud.ts and elsewhere
export type FormulaColumnDef = Extract<ColumnDef, { kind: "formula" }>;
