import { expect, test } from "bun:test";

import { toHexColor } from "./css-color";

test("hex passes as 6 or 8 digits; short hex expands, which Monaco's token colors need", () => {
  expect(toHexColor("#0f1a2b")).toBe("#0f1a2b");
  expect(toHexColor("#0f1a2bcc")).toBe("#0f1a2bcc");
  expect(toHexColor("#f00")).toBe("#ff0000");
  expect(toHexColor(" #5fac ")).toBe("#55ffaacc");
});
