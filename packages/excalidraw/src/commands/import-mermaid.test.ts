import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getBoundTextMaxWidth } from "@excalidraw/element";

import type { ExcalidrawElement } from "../elements/excalidraw-types.ts";
import { convertMermaid } from "./import-mermaid.ts";
import { coMoveBoundElements } from "./move.ts";

const FLOWCHART = `flowchart TD
  subgraph Backend
    A[API Server] -->|SQL| B[(Database)]
    A --> C{Cache hit?}
  end
  C -->|yes| D((Done))
  C -->|no| B`;

function byId(elements: ExcalidrawElement[], id: string): ExcalidrawElement {
  const el = elements.find((e) => e.id === id);
  if (!el) throw new Error(`No element ${id}`);
  return el;
}

function boundText(elements: ExcalidrawElement[], containerId: string): ExcalidrawElement {
  const text = elements.find((e) => e.type === "text" && e.containerId === containerId);
  if (!text) throw new Error(`No bound text in ${containerId}`);
  return text;
}

function arrows(elements: ExcalidrawElement[]): ExcalidrawElement[] {
  return elements.filter((e) => e.type === "arrow");
}

function points(el: ExcalidrawElement): [number, number][] {
  return el.points as [number, number][];
}

/** Every segment is horizontal or vertical. */
function isOrthogonal(el: ExcalidrawElement): boolean {
  return points(el)
    .slice(1)
    .every(([x, y], i) => {
      const [px, py] = points(el)[i]!;
      return Math.abs(x - px) < 0.5 || Math.abs(y - py) < 0.5;
    });
}

function bindingTarget(arrow: ExcalidrawElement, end: "startBinding" | "endBinding"): string {
  return (arrow[end] as { elementId: string } | null)?.elementId ?? "";
}

describe("flowchart", async () => {
  const { elements } = await convertMermaid(FLOWCHART);

  test("keeps node IDs and shapes, with subgraphs as titled rectangles", () => {
    expect(byId(elements, "A").type).toBe("rectangle");
    expect(byId(elements, "C").type).toBe("diamond");
    expect(byId(elements, "D").type).toBe("ellipse");
    expect(byId(elements, "Backend").type).toBe("rectangle");
    expect(boundText(elements, "Backend__title").text).toBe("Backend");
    expect(boundText(elements, "A").text).toBe("API Server");
  });

  test("draws edges as elbow arrows bound to the shapes they connect", () => {
    const edges = arrows(elements);
    expect(edges.map((a) => a.id).toSorted()).toEqual(["A_B", "A_C", "C_B", "C_D"]);
    for (const arrow of edges) {
      expect(arrow.elbowed).toBe(true);
      expect(arrow.roundness).toBeNull();
      expect(isOrthogonal(arrow)).toBe(true);
      const [from, to] = arrow.id.split("_") as [string, string];
      expect(bindingTarget(arrow, "startBinding")).toBe(from);
      expect(bindingTarget(arrow, "endBinding")).toBe(to);
      for (const shapeId of [from, to]) {
        const bound = byId(elements, shapeId).boundElements as { id: string }[];
        expect(bound.map((b) => b.id)).toContain(arrow.id);
      }
    }
    expect(boundText(elements, "A_B").text).toBe("SQL");
  });

  test("sizes arrows to their points", () => {
    for (const arrow of arrows(elements)) {
      const xs = points(arrow).map(([x]) => x);
      const ys = points(arrow).map(([, y]) => y);
      expect(arrow.width).toBeCloseTo(Math.max(...xs) - Math.min(...xs));
      expect(arrow.height).toBeCloseTo(Math.max(...ys) - Math.min(...ys));
    }
  });

  test("fits every label in the space Excalidraw gives it", () => {
    for (const text of elements.filter((e) => e.type === "text" && e.containerId)) {
      const container = byId(elements, text.containerId as string);
      if (container.type === "arrow") continue;
      const maxWidth = getBoundTextMaxWidth(
        container as unknown as Parameters<typeof getBoundTextMaxWidth>[0],
        null,
      );
      expect(text.width).toBeLessThanOrEqual(maxWidth);
    }
  });

  test("leaves fractional indices to Excalidraw", () => {
    expect(elements.every((el) => el.index === null)).toBe(true);
  });
});

test("--curved draws curved arrows that `move` can still re-attach", async () => {
  const { elements } = await convertMermaid(FLOWCHART, { curved: true });
  const edge = byId(elements, "C_B");
  expect(edge.elbowed).toBe(false);
  expect(edge.roundness).not.toBeNull();
  expect(bindingTarget(edge, "startBinding")).toBe("C");
  const binding = edge.endBinding as { fixedPoint?: [number, number] };
  expect(binding.fixedPoint).toHaveLength(2);
});

test("moving a shape re-routes its elbow arrows orthogonally", async () => {
  const { elements } = await convertMermaid(FLOWCHART);
  const database = byId(elements, "B");
  database.x += 150;
  database.y += 60;
  coMoveBoundElements([database], 150, 60, elements);

  for (const id of ["A_B", "C_B"]) {
    const arrow = byId(elements, id);
    expect(isOrthogonal(arrow)).toBe(true);
    // The arrow ends at the moved shape's top edge (less the binding gap).
    const [endX, endY] = points(arrow).at(-1)!;
    expect(arrow.x + endX).toBeGreaterThanOrEqual(database.x);
    expect(arrow.x + endX).toBeLessThanOrEqual(database.x + database.width);
    expect(Math.abs(arrow.y + endY - database.y)).toBeLessThan(10);
  }
});

test("sequence diagram: participants, messages and blocks", async () => {
  const { elements } = await convertMermaid(`sequenceDiagram
    participant U as User
    participant S as Server
    U->>S: Login
    S-->>U: Token
    loop Every minute
      U->>S: Ping
    end`);
  expect(boundText(elements, "U-top").text).toBe("User");
  expect(boundText(elements, "S-bottom").text).toBe("Server");
  const labels = arrows(elements).map((a) => boundText(elements, a.id).text);
  expect(labels).toEqual(["Login", "Token", "Ping"]);
  // The loop's tag is a rectangle the converter sizes to its "loop" label.
  const tag = elements.find(
    (e) =>
      e.type === "rectangle" && elements.some((t) => t.containerId === e.id && t.text === "loop"),
  );
  expect(tag?.width).toBeGreaterThan(0);
  expect(tag?.height).toBeGreaterThan(0);
});

test("class diagram: inheritance has a hollow triangle at the parent and no head at the child", async () => {
  const { elements } = await convertMermaid(`classDiagram
    class Animal {
      +String name
      +eat()
    }
    class Dog
    Animal <|-- Dog`);
  expect(boundText(elements, "Animal").text).toBe("Animal");
  expect(elements.some((e) => e.type === "text" && e.text === "+eat()")).toBe(true);
  const [inheritance] = arrows(elements);
  expect(inheritance?.startArrowhead).toBe("triangle_outline");
  expect(inheritance?.endArrowhead).toBeNull();
});

test("swimlane titles are drawn at their header's angle", async () => {
  const { elements } = await convertMermaid(`swimlane-beta LR
    subgraph Customer
      A[Order] --> B[Pay]
    end
    subgraph Shop
      C[Ship]
    end
    B --> C`);
  const header = byId(elements, "Customer__title");
  expect(header.angle).not.toBe(0);
  expect(boundText(elements, "Customer__title").angle).toBe(header.angle);
});

test.each([
  ["erDiagram", "erDiagram\n  CUSTOMER ||--o{ ORDER : places", "entity-CUSTOMER-0"],
  ["stateDiagram-v2", "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running : start", "Idle"],
  [
    "gantt",
    "gantt\n  dateFormat YYYY-MM-DD\n  section Build\n  Design :d1, 2026-01-01, 3d",
    undefined,
  ],
  [
    "quadrantChart",
    "quadrantChart\n  x-axis Low --> High\n  y-axis Low --> High\n  Campaign A: [0.3, 0.6]",
    undefined,
  ],
  ["timeline", "timeline\n  2002 : LinkedIn\n  2004 : Facebook", undefined],
])("%s converts to editable elements", async (_type, definition, nodeId) => {
  const { elements } = await convertMermaid(definition);
  expect(elements.length).toBeGreaterThan(1);
  expect(elements.some((e) => e.type === "image")).toBe(false);
  if (nodeId) expect(byId(elements, nodeId).type).toBe("rectangle");
});

test("rejects diagram types that only convert to an image", async () => {
  await expect(convertMermaid('pie title Pets\n  "Dogs" : 386')).rejects.toThrow(
    /converts to an image.*Supported diagram types: flowchart/,
  );
});

test("reports syntax errors with their location", async () => {
  await expect(convertMermaid("flowchart TD\n  A[[[ -->")).rejects.toThrow(
    /^Invalid mermaid definition: Parse error on line 2/,
  );
});

test("lists the supported types for an unknown diagram type", async () => {
  await expect(convertMermaid("notADiagram\n  A --> B")).rejects.toThrow(
    /No diagram type detected.*Supported diagram types/,
  );
});

describe("import mermaid command", () => {
  const cli = path.join(import.meta.dirname, "../cli.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "excalidraw-import-mermaid-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function run(args: string[], stdin: string) {
    const proc = Bun.spawn(["bun", cli, ...args], {
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  test("imports into the file at an offset", async () => {
    const file = path.join(dir, "import.excalidraw");
    expect((await run(["-f", file, "create"], "")).exitCode).toBe(0);
    const result = await run(
      ["-f", file, "import", "mermaid", "-x", "1000", "--json"],
      "flowchart LR\n  A --> B",
    );
    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(result.stdout) as { elements: { id: string }[] };
    expect(summary.elements.map((e) => e.id)).toEqual(["A_B", "A", "B"]);
    const saved = (await Bun.file(file).json()) as { elements: ExcalidrawElement[] };
    expect(byId(saved.elements, "A").x).toBeGreaterThan(1000);
  });

  test.each([
    [
      "text",
      [],
      (stdout: string) => expect(stdout).toStartWith("Error: Invalid mermaid definition"),
    ],
    [
      "--json",
      ["--json"],
      (stdout: string) =>
        expect(JSON.parse(stdout)).toMatchObject({
          error: true,
          message: expect.stringContaining("Parse error on line 2"),
        }),
    ],
  ])("a syntax error exits 1 with a clean error in %s mode", async (_mode, flags, check) => {
    const file = path.join(dir, `syntax-${flags.length}.excalidraw`);
    await run(["-f", file, "create"], "");
    const result = await run(
      ["-f", file, "import", "mermaid", ...flags],
      "flowchart TD\n  A[[[ -->",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    check(result.stdout);
  });

  test("an image-only diagram type exits 1", async () => {
    const file = path.join(dir, "pie.excalidraw");
    await run(["-f", file, "create"], "");
    const result = await run(["-f", file, "import", "mermaid"], 'pie\n  "Dogs" : 386');
    expect(result.exitCode).toBe(1);
  });
});
