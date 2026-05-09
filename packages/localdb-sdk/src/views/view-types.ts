export type ComponentKey = string;

export type ViewDef =
  | TableViewDef
  | KanbanViewDef
  | FormViewDef
  | CalendarViewDef
  | GraphViewDef
  | GanttViewDef;

export interface TableViewDef {
  type: "table";
  /** Maps column name → ComponentKey controlling which UI component renders it */
  columnComponents?: Record<string, ComponentKey>;
  columnOrder?: string[];
  hiddenColumns?: string[];
}

export interface KanbanViewDef {
  type: "kanban";
  groupByColumn: string;
  cardColumns?: string[];
  cardTitleColumn?: string;
}

export interface FormViewDef {
  type: "form";
  fieldOrder?: string[];
  readonlyColumns?: string[];
  hiddenColumns?: string[];
}

export interface CalendarViewDef {
  type: "calendar";
  dateColumn: string;
  labelColumn?: string;
  endDateColumn?: string;
}

export interface GraphViewDef {
  type: "graph";
  xColumn: string;
  yColumn: string;
  chartKind: "bar" | "line" | "scatter" | "pie";
  groupByColumn?: string;
}

export interface GanttViewDef {
  type: "gantt";
  startColumn: string;
  endColumn: string;
  labelColumn?: string;
  groupByColumn?: string;
}

export type ViewType = ViewDef["type"];
