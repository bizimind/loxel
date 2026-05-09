import type { ColumnDef, ValidationIssue } from "@bizimind/localdb-sdk";

/** Props shared by all read-only field display components */
export interface FieldViewProps<T> {
  value: T | null | undefined;
  schema: ColumnDef;
  className?: string;
}

/** Props shared by all editable field components */
export interface FieldEditProps<T> {
  value: T | null | undefined;
  schema: ColumnDef;
  onChange: (value: T | null) => void;
  issues?: ValidationIssue[];
  disabled?: boolean;
  className?: string;
}

/** Registry key — identifies which component to use for a column in a view */
export type ComponentKey = string;

export interface RegisteredFieldComponent<TView = unknown, TEdit = TView> {
  key: ComponentKey;
  /** Column kinds this component is compatible with */
  compatibleKinds: ColumnDef["kind"][];
  label: string;
  View: React.ComponentType<FieldViewProps<TView>>;
  Edit: React.ComponentType<FieldEditProps<TEdit>>;
}

import type React from "react";
