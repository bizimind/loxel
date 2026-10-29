import { describe, expect, test } from "bun:test";

import { ModelRouter } from "../src/orchestrator/model-router.ts";

describe("ModelRouter env fallbacks", () => {
  test("reads the key and per-profile models from the env it is given", () => {
    const router = new ModelRouter({}, undefined, {
      OPENROUTER_API_KEY: "env-key",
      OPENROUTER_MODEL_PLANNER: "env/planner",
      OPENROUTER_WEBSEARCH_MODEL: "env/search",
      OPENROUTER_WEBSEARCH_FALLBACK_MODEL: "env/search-fallback",
    });

    expect(router.resolveModelId("planner")).toBe("env/planner");
    expect(router.resolveModelId("executor")).toBe("moonshotai/kimi-k2.5");
    expect(router.getWebSearchConfig()).toEqual({ modelId: "env/search", apiKey: "env-key" });
    expect(router.getWebSearchFallbackConfig()).toEqual({
      modelId: "env/search-fallback",
      apiKey: "env-key",
    });
  });

  test("ignores process.env when an env is given", () => {
    const original = process.env.OPENROUTER_WEBSEARCH_MODEL;
    process.env.OPENROUTER_WEBSEARCH_MODEL = "process/search";
    try {
      const router = new ModelRouter({}, undefined, { OPENROUTER_API_KEY: "env-key" });
      expect(router.getWebSearchConfig()).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_WEBSEARCH_MODEL;
      else process.env.OPENROUTER_WEBSEARCH_MODEL = original;
    }
  });

  test("falls back to process.env without an env", () => {
    const originalKey = process.env.OPENROUTER_API_KEY;
    const originalModel = process.env.OPENROUTER_MODEL_JUDGE;
    process.env.OPENROUTER_API_KEY = "process-key";
    process.env.OPENROUTER_MODEL_JUDGE = "process/judge";
    try {
      expect(new ModelRouter().resolveModelId("judge")).toBe("process/judge");
    } finally {
      if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalKey;
      if (originalModel === undefined) delete process.env.OPENROUTER_MODEL_JUDGE;
      else process.env.OPENROUTER_MODEL_JUDGE = originalModel;
    }
  });

  test("the WebSearch fallback from the env uses the WebSearch model's key without a base key", () => {
    const router = new ModelRouter(
      { webSearch: { modelId: "settings/search", apiKey: "search-key" } },
      undefined,
      { OPENROUTER_WEBSEARCH_FALLBACK_MODEL: "env/search-fallback" },
    );
    expect(router.getWebSearchFallbackConfig()).toEqual({
      modelId: "env/search-fallback",
      apiKey: "search-key",
    });
  });

  test("explicit models win over the env", () => {
    const router = new ModelRouter(
      {
        base: { modelId: "settings/base", apiKey: "settings-key" },
        planner: { modelId: "settings/planner", apiKey: "settings-key" },
        webSearch: { modelId: "settings/search", apiKey: "settings-key" },
      },
      undefined,
      {
        OPENROUTER_API_KEY: "env-key",
        OPENROUTER_MODEL_PLANNER: "env/planner",
        OPENROUTER_WEBSEARCH_MODEL: "env/search",
      },
    );

    expect(router.resolveModelId("planner")).toBe("settings/planner");
    expect(router.getWebSearchConfig()).toEqual({
      modelId: "settings/search",
      apiKey: "settings-key",
    });
  });
});
