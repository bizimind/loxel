/** A plain JSON excalidraw element — loosely typed for flexibility */
export type ExcalidrawElement = Record<string, unknown> & {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted: boolean;
};
