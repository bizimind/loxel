/**
 * Wrapped @inquirer/prompts that automatically redirect output to stderr
 * when stdout is piped. This allows `wt view -j | jq` to work correctly:
 * prompts render on stderr (visible to user), JSON goes to stdout (piped).
 */
import {
  select as inquirerSelect,
  search as inquirerSearch,
  confirm as inquirerConfirm,
  input as inquirerInput,
} from "@inquirer/prompts";

function getPromptConfig() {
  if (process.stdout.isTTY !== true) {
    return { output: process.stderr };
  }
  return {};
}

export const select: typeof inquirerSelect = (config, context) =>
  inquirerSelect(config, { ...getPromptConfig(), ...context });

export const confirm: typeof inquirerConfirm = (config, context) =>
  inquirerConfirm(config, { ...getPromptConfig(), ...context });

export const search: typeof inquirerSearch = (config, context) =>
  inquirerSearch(config, { ...getPromptConfig(), ...context });

export const input: typeof inquirerInput = (config, context) =>
  inquirerInput(config, { ...getPromptConfig(), ...context });
