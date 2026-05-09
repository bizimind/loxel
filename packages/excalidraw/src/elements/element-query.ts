import type { ExcalidrawElement } from "./excalidraw-types.ts";

export function findElementById(
  elements: readonly ExcalidrawElement[],
  id: string,
): ExcalidrawElement | undefined {
  return elements.find((el) => el.id === id && !el.isDeleted);
}

export function findElementByIdOrThrow(
  elements: readonly ExcalidrawElement[],
  id: string,
): ExcalidrawElement {
  const el = findElementById(elements, id);
  if (!el) {
    throw new Error(`Element not found: ${id}`);
  }
  return el;
}

export function filterByType(
  elements: readonly ExcalidrawElement[],
  type: string,
): ExcalidrawElement[] {
  return elements.filter((el) => el.type === type && !el.isDeleted);
}

export function filterByGroupId(
  elements: readonly ExcalidrawElement[],
  groupId: string,
): ExcalidrawElement[] {
  return elements.filter(
    (el) => !el.isDeleted && Array.isArray(el.groupIds) && el.groupIds.includes(groupId),
  );
}

export function activeElements(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  return elements.filter((el) => !el.isDeleted);
}

/** Get the center point of an element */
export function elementCenter(el: ExcalidrawElement): { cx: number; cy: number } {
  return { cx: el.x + el.width / 2, cy: el.y + el.height / 2 };
}
