import { expect } from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import * as matchers from "@testing-library/jest-dom/matchers";

GlobalRegistrator.register();

Element.prototype.scrollIntoView = function scrollIntoView() {};

expect.extend(matchers);
