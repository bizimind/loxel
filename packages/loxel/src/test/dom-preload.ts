import { GlobalRegistrator } from "@happy-dom/global-registrator";
import * as matchers from "@testing-library/jest-dom/matchers";
import { expect } from "bun:test";

GlobalRegistrator.register();

Element.prototype.scrollIntoView = function scrollIntoView() {};

expect.extend(matchers);
