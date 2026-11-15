import { expect, test } from "bun:test";

import { toolchainStatuses } from "@/api/toolchain-statuses";

import { toolchainStatusModules } from "./toolchain-statuses";

test("every toolchain has one server module", () => {
  const ids = (toolchains: ReadonlyArray<{ id: string }>) => toolchains.map(({ id }) => id).sort();
  expect(ids(toolchainStatusModules.map(({ toolchain }) => toolchain))).toEqual(
    ids(toolchainStatuses),
  );
});

test("no two toolchains claim the same route", () => {
  const routes = toolchainStatusModules.flatMap(({ routes: { GET, POST } }) => [
    ...Object.keys(GET).map((route) => `GET ${route}`),
    ...Object.keys(POST).map((route) => `POST ${route}`),
  ]);
  expect(new Set(routes).size).toBe(routes.length);
});
