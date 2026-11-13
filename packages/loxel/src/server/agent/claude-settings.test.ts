import { describe, expect, test } from "bun:test";

import { mergeStartingSettings, startingEvents } from "./claude-settings";

describe("starting settings", () => {
  test("later files and the env win, as in Claude Code", () => {
    const merged = mergeStartingSettings(
      [
        { model: "opus", effortLevel: "medium", permissions: { defaultMode: "plan" } },
        { effortLevel: "high" },
      ],
      { ANTHROPIC_MODEL: "claude-haiku-5-5" },
    );
    expect(merged).toEqual({ model: "claude-haiku-5-5", effort: "high", permissionMode: "plan" });
  });

  test("a model's own effort beats the top-level one, through its alias", () => {
    const settings = mergeStartingSettings(
      [
        {
          model: "opus",
          effortLevel: "medium",
          modelSettings: { "claude-opus-5-5": { effortLevel: "high" } },
        },
      ],
      {},
    );
    const catalog = {
      type: "catalog" as const,
      models: [
        {
          value: "opus",
          resolvedModel: "claude-opus-5-5",
          displayName: "Opus",
          description: "Opus 5.5 · Best for everyday, complex tasks",
          effortLevels: [],
        },
      ],
    };
    expect(startingEvents(settings, catalog)).toContainEqual({ type: "effort", effort: "high" });
  });

  test("with no settings: the catalog's default model and the default mode, never blank", () => {
    const catalog = {
      type: "catalog" as const,
      models: [
        {
          value: "default",
          resolvedModel: "claude-opus-5-5",
          displayName: "Default (recommended)",
          description: "Opus 5.5 · Best for everyday, complex tasks",
          effortLevels: [],
        },
      ],
    };
    expect(startingEvents({}, catalog)).toEqual([
      catalog,
      { type: "model", model: "claude-opus-5-5" },
      { type: "permission_mode", mode: "default" },
    ]);
  });
});
