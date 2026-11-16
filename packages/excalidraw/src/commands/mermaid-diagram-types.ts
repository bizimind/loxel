/**
 * The Mermaid diagram types `import mermaid` converts to editable elements, as
 * listed in the command's help and errors. Other types (pie, mindmap,
 * gitGraph, ...) only convert to an image, which the import rejects.
 */
export const MERMAID_DIAGRAM_TYPES = [
  "flowchart/graph (with subgraphs)",
  "swimlane-beta",
  "sequenceDiagram",
  "classDiagram",
  "erDiagram",
  "stateDiagram-v2",
  "gantt",
  "quadrantChart",
  "timeline",
] as const;
