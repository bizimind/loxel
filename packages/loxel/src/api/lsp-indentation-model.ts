import { z } from "zod";

/**
 * Client→bridge notification on the TypeScript language-server socket: the indentation of a live
 * editor model (its `insertSpaces`, `tabSize` and `indentSize`), sent for every model when the
 * socket connects and again whenever a model's options change. The bridge consumes it; TypeScript
 * never sees it.
 */
export const DOCUMENT_INDENTATION_METHOD = "loxel/documentIndentation";

export const documentIndentationSchema = z.object({
  tabSize: z.number().int().positive(),
  indentSize: z.number().int().positive(),
  insertSpaces: z.boolean(),
});

export type DocumentIndentation = z.infer<typeof documentIndentationSchema>;

export const documentIndentationParamsSchema = z.object({
  textDocument: z.object({ uri: z.string() }),
  indentation: documentIndentationSchema,
});

export type DocumentIndentationParams = z.infer<typeof documentIndentationParamsSchema>;
