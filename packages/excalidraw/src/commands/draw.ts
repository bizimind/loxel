import { createResult, runAction } from "@bizimind/cli-common";
import path from "node:path";

import type { ExcalidrawElement } from "../elements/excalidraw-types.ts";

import { withDom } from "../dom-shim.ts";
import {
  buildArrowSkeleton,
  buildContainerSkeleton,
  buildFreeDrawSkeleton,
  buildFrameSkeleton,
  buildLineSkeleton,
  buildTextSkeleton,
  convertSkeletons,
  type ArrowOptions,
  type ContainerOptions,
  type FrameOptions,
  type BaseOptions,
  type TextOptions,
} from "../elements/element-factory.ts";
import { validateIdUnique } from "../elements/element-id.ts";
import { loadFile, saveFile } from "../file/excalidraw-file.ts";

interface DrawResult {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  textId?: string;
}

function formatDrawResult(r: DrawResult): string {
  const text = r.textId ? ` (text: ${r.textId})` : "";
  return `Created ${r.type} ${r.id} at (${r.x}, ${r.y}) size ${r.width}x${r.height}${text}`;
}

type ContainerType = "rectangle" | "ellipse" | "diamond";

export async function drawShape(
  type: string,
  filePath: string,
  opts: ContainerOptions & { json?: boolean },
): Promise<void> {
  await runAction<DrawResult>(opts, async () => {
    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);
    if (opts.id) validateIdUnique(file.elements, opts.id);

    const skeleton = buildContainerSkeleton(type as ContainerType, opts);
    const converted = await withDom(() => convertSkeletons([skeleton]));
    file.elements.push(...converted);
    await saveFile(resolved, file);

    const container = converted.find((el) => el.type === type)!;
    const boundText = converted.find((el) => el.type === "text");

    return createResult<DrawResult>(
      {
        id: container.id,
        type: container.type,
        x: Math.round(container.x),
        y: Math.round(container.y),
        width: Math.round(container.width),
        height: Math.round(container.height),
        textId: boundText?.id,
      },
      formatDrawResult,
    );
  });
}

export async function drawText(
  filePath: string,
  content: string,
  opts: Omit<TextOptions, "text"> & { json?: boolean },
): Promise<void> {
  await runAction<DrawResult>(opts, async () => {
    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);
    if (opts.id) validateIdUnique(file.elements, opts.id);

    const skeleton = buildTextSkeleton({ ...opts, text: content });
    const converted = await withDom(() => convertSkeletons([skeleton]));
    file.elements.push(...converted);
    await saveFile(resolved, file);

    const el = converted[0]!;
    return createResult<DrawResult>(
      {
        id: el.id,
        type: el.type,
        x: Math.round(el.x),
        y: Math.round(el.y),
        width: Math.round(el.width),
        height: Math.round(el.height),
      },
      formatDrawResult,
    );
  });
}

export async function drawLinear(
  _type: "line",
  filePath: string,
  opts: BaseOptions & { points?: string; json?: boolean },
): Promise<void> {
  await runAction<DrawResult>(opts, async () => {
    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);
    if (opts.id) validateIdUnique(file.elements, opts.id);

    const points = opts.points ? parsePoints(opts.points as string) : undefined;
    const skeleton = buildLineSkeleton({ ...opts, points });
    const converted = await withDom(() => convertSkeletons([skeleton]));
    file.elements.push(...converted);
    await saveFile(resolved, file);

    const el = converted[0]!;
    return createResult<DrawResult>(
      {
        id: el.id,
        type: el.type,
        x: Math.round(el.x),
        y: Math.round(el.y),
        width: Math.round(el.width),
        height: Math.round(el.height),
      },
      formatDrawResult,
    );
  });
}

export async function drawArrow(
  filePath: string,
  opts: Omit<ArrowOptions, "points"> & {
    points?: string;
    from?: string;
    to?: string;
    json?: boolean;
  },
): Promise<void> {
  await runAction<DrawResult>(opts, async () => {
    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);
    if (opts.id) validateIdUnique(file.elements, opts.id);

    const points = opts.points ? parsePoints(opts.points as string) : undefined;
    const skeleton = buildArrowSkeleton({ ...opts, points });
    const converted = await withDom(() => convertSkeletons([skeleton], file.elements));
    file.elements.push(...converted);
    await saveFile(resolved, file);

    const arrow = converted.find((el) => el.type === "arrow")!;
    const boundText = converted.find((el) => el.type === "text");

    return createResult<DrawResult>(
      {
        id: arrow.id,
        type: arrow.type,
        x: Math.round(arrow.x),
        y: Math.round(arrow.y),
        width: Math.round(arrow.width),
        height: Math.round(arrow.height),
        textId: boundText?.id,
      },
      formatDrawResult,
    );
  });
}

export async function drawFreeDraw(
  filePath: string,
  opts: BaseOptions & { points?: string; json?: boolean },
): Promise<void> {
  await runAction<DrawResult>(opts, async () => {
    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);
    if (opts.id) validateIdUnique(file.elements, opts.id);

    if (!opts.points) throw new Error("--points is required for freedraw");
    const points = parsePoints(opts.points as string);
    const skeleton = buildFreeDrawSkeleton({ ...opts, points });
    // Freedraw doesn't need convertSkeletons — no bindings
    file.elements.push(skeleton as unknown as ExcalidrawElement);
    await saveFile(resolved, file);

    return createResult<DrawResult>(
      {
        id: skeleton.id as string,
        type: "freedraw",
        x: Math.round(skeleton.x as number),
        y: Math.round(skeleton.y as number),
        width: 0,
        height: 0,
      },
      formatDrawResult,
    );
  });
}

export async function drawFrame(
  filePath: string,
  opts: FrameOptions & { children?: string; json?: boolean },
): Promise<void> {
  await runAction<DrawResult>(opts, async () => {
    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);
    if (opts.id) validateIdUnique(file.elements, opts.id);

    const childIds =
      typeof opts.children === "string" ? opts.children.split(",").map((s) => s.trim()) : undefined;
    const skeleton = buildFrameSkeleton({ ...opts, children: childIds });
    const converted = await withDom(() => convertSkeletons([skeleton]));
    file.elements.push(...converted);
    await saveFile(resolved, file);

    const el = converted.find((e) => e.type === "frame")!;
    return createResult<DrawResult>(
      {
        id: el.id,
        type: el.type,
        x: Math.round(el.x),
        y: Math.round(el.y),
        width: Math.round(el.width),
        height: Math.round(el.height),
      },
      formatDrawResult,
    );
  });
}

function parsePoints(json: string): [number, number][] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("Points must be a JSON array of [x,y] pairs");
  for (let i = 0; i < parsed.length; i++) {
    const pt = parsed[i];
    if (
      !Array.isArray(pt) ||
      pt.length !== 2 ||
      typeof pt[0] !== "number" ||
      typeof pt[1] !== "number"
    ) {
      throw new Error(
        `Invalid point at index ${i}: expected [number, number], got ${JSON.stringify(pt)}`,
      );
    }
  }
  return parsed as [number, number][];
}
