/** Files to copy and commands to run that workspace setup suggests for a project directory. */
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ScanSuggestionsResult } from "@/api/project-model";

import { languageSetupCommands } from "./language-setup-suggestions";

/** Detection rules for auto-suggesting workspace setup files and commands. */
const SUGGESTION_RULES: Array<{ file: string; copyFile?: string; commands?: string[] }> = [
  { file: "bun.lock", commands: ["bun i --frozen-lockfile"] },
  { file: "bun.lockb", commands: ["bun i --frozen-lockfile"] },
  { file: "pnpm-lock.yaml", commands: ["pnpm i --frozen-lockfile"] },
  { file: "package-lock.json", commands: ["npm ci"] },
  { file: "yarn.lock", commands: ["yarn install --frozen-lockfile"] },
  { file: ".env", copyFile: ".env" },
  { file: ".env.local", copyFile: ".env.local" },
  { file: ".envrc", copyFile: ".envrc", commands: ["direnv allow"] },
  { file: ".mise.toml", commands: ["mise trust", "mise i"] },
  { file: ".tool-versions", commands: ["mise trust", "mise i"] },
];

/**
 * A language's setup commands for `dirPath`, listed in `language-setup-suggestions.ts`. `PATH` is
 * the one the setup hook will run with, to choose between equivalent commands.
 */
export type LanguageSetupCommands = (dirPath: string, PATH: string) => string[] | Promise<string[]>;

/**
 * Suggest setup for `dirPath`. `PATH` decides between equivalent commands (uv when it is
 * installed); pass the PATH the setup hook will run with.
 */
export async function scanSetupSuggestions(
  dirPath: string,
  PATH: string,
): Promise<ScanSuggestionsResult> {
  const files: string[] = [];
  const commands: string[] = [];
  const addCommand = (cmd: string) => {
    if (!commands.includes(cmd)) commands.push(cmd);
  };

  for (const rule of SUGGESTION_RULES) {
    if (!existsSync(join(dirPath, rule.file))) continue;
    if (rule.copyFile && !files.includes(rule.copyFile)) files.push(rule.copyFile);
    for (const cmd of rule.commands ?? []) addCommand(cmd);
  }

  for (const languageCommands of languageSetupCommands) {
    for (const cmd of await languageCommands(dirPath, PATH)) addCommand(cmd);
  }

  return { files, commands };
}
