import { $ } from "bun";

import type { StatusInfo } from "@/api/git-models";

import { parseStatusOutput } from "../parsers/status";
import { FSMONITOR, readOnlyGitEnv } from "./git-env";

export async function getStatus(cwd: string): Promise<StatusInfo> {
  const result = await $`git ${FSMONITOR} -C ${cwd} status --porcelain=v2 --branch`
    .env(readOnlyGitEnv())
    .text();
  return parseStatusOutput(result);
}
