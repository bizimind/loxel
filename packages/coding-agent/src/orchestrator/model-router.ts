import { createNoopLogger, type AppLogger } from "@bizimind/logger";
import { createOpenRouter, type OpenRouterProvider } from "@openrouter/ai-sdk-provider";

export type ModelProfile = "planner" | "executor" | "fallback" | "judge";

/** Resolved model + API key pair for a single function. */
export interface ModelConfig {
  modelId: string;
  apiKey: string;
}

export interface ModelRouterOptions {
  /** Default config for all functions. Falls back to env vars if omitted. */
  base?: ModelConfig;
  /** Per-function overrides (each can carry its own apiKey). */
  planner?: ModelConfig;
  executor?: ModelConfig;
  fallback?: ModelConfig;
  judge?: ModelConfig;
  webSearch?: ModelConfig;
  webSearchFallback?: ModelConfig;
}

const DEFAULT_MODELS: Record<ModelProfile, string> = {
  planner: "z-ai/glm-5",
  executor: "moonshotai/kimi-k2.5",
  fallback: "openrouter/auto",
  judge: "anthropic/claude-3-haiku",
};

export class ModelRouter {
  private readonly providers = new Map<string, OpenRouterProvider>();
  private readonly configs: Record<ModelProfile, ModelConfig | undefined>;
  private readonly webSearchConfig: ModelConfig | undefined;
  private readonly webSearchFallbackConfig: ModelConfig | undefined;
  private readonly baseApiKey: string | undefined;
  private readonly logger: AppLogger;

  constructor(options: ModelRouterOptions = {}, logger: AppLogger = createNoopLogger()) {
    this.logger = logger.with({ component: "model-router" });

    const baseApiKey = options.base?.apiKey ?? process.env.OPENROUTER_API_KEY;
    this.baseApiKey = baseApiKey;

    this.configs = {
      planner: this.resolveConfig(options.planner, options.base, "planner"),
      executor: this.resolveConfig(options.executor, options.base, "executor"),
      fallback: this.resolveConfig(options.fallback, options.base, "fallback"),
      judge: this.resolveConfig(options.judge, options.base, "judge"),
    };

    this.webSearchConfig =
      options.webSearch ?? this.configFromEnv(process.env.OPENROUTER_WEBSEARCH_MODEL, baseApiKey);
    this.webSearchFallbackConfig =
      options.webSearchFallback ??
      this.configFromEnv(process.env.OPENROUTER_WEBSEARCH_FALLBACK_MODEL, baseApiKey);

    this.logger.info("Model router configured", {
      plannerModel: this.configs.planner?.modelId,
      executorModel: this.configs.executor?.modelId,
      fallbackModel: this.configs.fallback?.modelId,
      judgeModel: this.configs.judge?.modelId,
      webSearchModel: this.webSearchConfig?.modelId,
      hasApiKey: Boolean(baseApiKey),
    });

    if (!baseApiKey) {
      this.logger.warn("No API key configured (base.apiKey or OPENROUTER_API_KEY)");
    }
  }

  resolveModelId(profile: ModelProfile): string {
    return this.configs[profile]?.modelId ?? DEFAULT_MODELS[profile];
  }

  getModel(profile: ModelProfile) {
    const config = this.configs[profile];
    const modelId = config?.modelId ?? DEFAULT_MODELS[profile];
    const apiKey = config?.apiKey ?? this.baseApiKey;
    this.logger.debug("Selecting model", { profile, modelId });
    return this.getOrCreateProvider(apiKey)(modelId);
  }

  /** Get the resolved config for a profile (for threading into tool context). */
  getWebSearchConfig(): ModelConfig | undefined {
    return this.webSearchConfig;
  }

  getWebSearchFallbackConfig(): ModelConfig | undefined {
    return this.webSearchFallbackConfig;
  }

  private resolveConfig(
    explicit: ModelConfig | undefined,
    base: ModelConfig | undefined,
    profile: ModelProfile,
  ): ModelConfig | undefined {
    if (explicit) return explicit;

    const envModelKey = `OPENROUTER_MODEL_${profile.toUpperCase()}`;
    const envModelId = process.env[envModelKey];
    const apiKey = base?.apiKey ?? process.env.OPENROUTER_API_KEY;

    if (envModelId && apiKey) return { modelId: envModelId, apiKey };
    if (base) return { modelId: base.modelId, apiKey: base.apiKey };
    if (apiKey) return { modelId: DEFAULT_MODELS[profile], apiKey };

    return undefined;
  }

  private configFromEnv(
    modelId: string | undefined,
    apiKey: string | undefined,
  ): ModelConfig | undefined {
    if (modelId && apiKey) return { modelId, apiKey };
    return undefined;
  }

  private getOrCreateProvider(apiKey: string | undefined): OpenRouterProvider {
    const key = apiKey ?? "";
    let provider = this.providers.get(key);
    if (!provider) {
      provider = createOpenRouter({ apiKey, compatibility: "strict" });
      this.providers.set(key, provider);
    }
    return provider;
  }
}
