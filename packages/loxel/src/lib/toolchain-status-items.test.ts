import { expect, test } from "bun:test";

import { toolchainStatuses } from "@/api/toolchain-statuses";

import { toolchainStatusItems } from "./toolchain-status-items";

test("every toolchain has one status item", () => {
  const ids = (toolchains: ReadonlyArray<{ id: string }>) => toolchains.map(({ id }) => id).sort();
  expect(ids(toolchainStatusItems.map(({ toolchain }) => toolchain))).toEqual(
    ids(toolchainStatuses),
  );
});
