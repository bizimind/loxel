import { describe, expect, it } from "bun:test";

import { groupKey, renderCellValue, renderValue } from "./KanbanBoard";

describe("KanbanBoard value helpers", () => {
  it("groups hydrated inline options by value and renders labels", () => {
    const option = { id: 10, value: 1, label: "Todo", position: 0 };

    expect(groupKey(option)).toBe("1");
    expect(renderValue(option)).toBe("Todo");
  });

  it("renders arrays of hydrated options by label", () => {
    expect(
      renderValue([
        { id: 10, value: 1, label: "Todo", position: 0 },
        { id: 11, value: 2, label: "Blocked", position: 1 },
      ]),
    ).toBe("Todo, Blocked");
  });

  it("formats duration card fields", () => {
    expect(renderCellValue(7200, { kind: "duration", label: "Duration" })).toBe("2h");
    expect(renderCellValue(5400, { kind: "duration", label: "Duration" })).toBe("1h 30m");
  });
});
