import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect } from "bun:test";
import { createRequire } from "node:module";

GlobalRegistrator.register();

Element.prototype.scrollIntoView = function scrollIntoView() {};

// jest-dom 7 loads Testing Library's `screen` module while evaluating its matcher
// bundle. Register the DOM first so `screen` binds to the real document body.
const matchers = createRequire(import.meta.url)("@testing-library/jest-dom/matchers") as Omit<
  typeof import("@testing-library/jest-dom/matchers"),
  "default"
>;

expect.extend(matchers);
