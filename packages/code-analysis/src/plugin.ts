import { z } from "zod";

export const VizTypeSchema = z.enum(["treemap", "network-graph"]);
export type VizType = z.infer<typeof VizTypeSchema>;

export type AnalysisRecord = { path: string; [key: string]: string | number | boolean | null };

export type PluginOption = {
  key: string;
  description: string;
  required?: boolean;
  default?: string;
};

export type TreemapConfig = {
  vizType: "treemap";
  title: string;
  unit: string;
  valueField: string;
  filter: Record<string, string | string[]>;
};

export type NetworkGraphConfig = {
  vizType: "network-graph";
  title: string;
  sourceField: string;
  targetField: string;
  weightField?: string;
  threshold?: number;
};

export type VizConfig = TreemapConfig | NetworkGraphConfig;

export type PluginMeta = {
  id: string;
  description: string;
  vizType: VizType;
  options?: PluginOption[];
  watchGlobs: string[];
};

export interface AnalysisPlugin {
  meta: PluginMeta;
  generate(workDir: string, args: Record<string, string>): Promise<AnalysisRecord[]>;
  buildConfig(workDir: string, args: Record<string, string>): VizConfig;
}

// Runtime validation schema for externally-loaded plugins (paths, npm packages).
const PluginMetaSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  vizType: VizTypeSchema,
  options: z
    .array(
      z.object({
        key: z.string().min(1),
        description: z.string(),
        required: z.boolean().optional(),
        default: z.string().optional(),
      }),
    )
    .optional(),
  watchGlobs: z.array(z.string()),
});

export const ExternalPluginSchema = z.object({
  meta: PluginMetaSchema,
  generate: z.custom<AnalysisPlugin["generate"]>((v) => typeof v === "function", {
    message: "generate must be a function",
  }),
  buildConfig: z.custom<AnalysisPlugin["buildConfig"]>((v) => typeof v === "function", {
    message: "buildConfig must be a function",
  }),
});

export function validatePlugin(value: unknown): AnalysisPlugin {
  return ExternalPluginSchema.parse(value) as AnalysisPlugin;
}

/**
 * Apply plugin option defaults and validate required options.
 * Exits the process with an error message if a required option is missing.
 */
export function resolveArgs(
  plugin: AnalysisPlugin,
  raw: Record<string, string>,
): Record<string, string> {
  const args = { ...raw };
  for (const opt of plugin.meta.options ?? []) {
    if (opt.key in args) continue;
    if (opt.default !== undefined) {
      args[opt.key] = opt.default;
    } else if (opt.required) {
      process.stderr.write(
        `Plugin "${plugin.meta.id}" requires --arg ${opt.key}=<value>  (${opt.description})\n`,
      );
      process.exit(1);
    }
  }
  return args;
}
