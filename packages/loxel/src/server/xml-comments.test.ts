import { expect, test } from "bun:test";

import { scanXmlComments, withoutXmlComments } from "./xml-comments";

test("comments are read left to right, as a parser does", () => {
  expect(withoutXmlComments("a<!-- b -->c<!--d-->e")).toBe("ace");
  expect(withoutXmlComments("<!<!-- x -->-- y -->z")).toBe("<!-- y -->z");
  expect(withoutXmlComments("<!-- a --> -->")).toBe(" -->");
});

test("one left open runs to the end, and says so", () => {
  expect(scanXmlComments("a<!-- open")).toEqual({ text: "a", unclosed: true });
  expect(scanXmlComments("a<!-- b -->")).toEqual({ text: "a", unclosed: false });
});
