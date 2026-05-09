// Adapters
export type { DataAdapter } from "./adapters/data-adapter.ts";
export { makeRestAdapter } from "./adapters/rest.ts";

// Field registry
export {
  registerField,
  getField,
  listFields,
  compatibleFields,
  defaultComponentKey,
  defaultComponentKeyForColumn,
} from "./fields/registry.ts";
export type {
  FieldViewProps,
  FieldEditProps,
  ComponentKey,
  RegisteredFieldComponent,
} from "./fields/field-props.ts";

// Field components — boolean
export { BooleanView, BooleanCheckbox } from "./fields/boolean/Checkbox.tsx";
export { BooleanToggleView, BooleanToggle } from "./fields/boolean/Toggle.tsx";

// Field components — number
export { NumberView, NumberInput } from "./fields/number/NumberInput.tsx";
export { RangeSliderView, RangeSlider } from "./fields/number/RangeSlider.tsx";

// Field components — text
export { TextView, TextInput } from "./fields/text/TextInput.tsx";

// Field components — longtext
export { LongTextView, LongTextTextarea } from "./fields/longtext/PlainTextarea.tsx";

// Field components — tags
export { TagsView, TagInput } from "./fields/tags/TagInput.tsx";

// Field components — select
export { SingleSelectView, SingleSelectCombobox } from "./fields/select/SingleSelect.tsx";
export { MultiSelectView, MultiSelectCheckboxes } from "./fields/select/MultiSelect.tsx";

// Field components — color
export { ColorView, ColorPicker } from "./fields/color/ColorPicker.tsx";

// Field components — url
export { UrlView, UrlInput } from "./fields/url/UrlInput.tsx";

// Field components — date / datetime / duration
export { DateView, DateEdit } from "./fields/date/DateInput.tsx";
export { DateTimeView, DateTimeEdit } from "./fields/datetime/DateTimeInput.tsx";
export { DurationView, DurationEdit } from "./fields/duration/DurationInput.tsx";

// Field components — formula (read-only)
export { FormulaDisplay } from "./fields/formula/FormulaDisplay.tsx";

// Schema builder
export { MigrationReview } from "./schema/MigrationReview.tsx";

// Views
export { DataTable } from "./views/table/DataTable.tsx";
export { RecordForm } from "./views/form/RecordForm.tsx";
export { KanbanBoard } from "./views/kanban/KanbanBoard.tsx";
export { CalendarView } from "./views/calendar/CalendarView.tsx";
export { GraphView } from "./views/graph/GraphView.tsx";
export { GanttView } from "./views/gantt/GanttView.tsx";
