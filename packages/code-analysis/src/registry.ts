import { resolve } from "node:path";

import { type AnalysisPlugin, validatePlugin } from "./plugin.ts";

const plugins: Map<string, AnalysisPlugin> = new Map();

export function registerPlugin(plugin: AnalysisPlugin): void {
  plugins.set(plugin.meta.id, plugin);
}

export function getPlugin(id: string): AnalysisPlugin | undefined {
  return plugins.get(id);
}

export function listPlugins(): AnalysisPlugin[] {
  return [...plugins.values()];
}

/**
 * Load a plugin by specifier. Accepts:
 *   - a built-in id (already registered): "loc"
 *   - a relative or absolute path: "./my-plugin.ts", "/abs/path.ts"
 *   - a node_modules package name: "code-analysis-plugin-foo"
 *
 * Returns the plugin if found/loaded, or null if the specifier didn't resolve
 * to a built-in (caller should treat null as "not a dynamic load").
 */
export async function loadPlugin(specifier: string): Promise<AnalysisPlugin | null> {
  // Already registered built-in — no dynamic load needed.
  const existing = plugins.get(specifier);
  if (existing) return existing;

  // Relative or absolute path → resolve to absolute before importing.
  const isPath = specifier.startsWith(".") || specifier.startsWith("/");

  // Bare id that isn't a registered built-in and isn't a path/package → unknown plugin.
  if (!isPath && !specifier.includes("/") && !specifier.startsWith("@")) return null;
  const importTarget = isPath ? resolve(process.cwd(), specifier) : specifier;

  let mod: unknown;
  try {
    mod = await import(importTarget);
  } catch (err) {
    throw new Error(
      `Failed to load plugin "${specifier}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Support both `export default plugin` and `module.exports = plugin`.
  const candidate = (mod as Record<string, unknown>)["default"] ?? mod;

  let plugin: AnalysisPlugin;
  try {
    plugin = validatePlugin(candidate);
  } catch (err) {
    throw new Error(
      `Plugin "${specifier}" has an invalid shape: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  registerPlugin(plugin);
  return plugin;
}

async function loadBuiltins(): Promise<void> {
  const mods = await Promise.all([
    import("./plugins/loc.ts"),
    import("./plugins/languages.ts"),
    import("./plugins/disk-utilization.ts"),
    import("./plugins/git-churn.ts"),
    import("./plugins/lint-issues.ts"),
    import("./plugins/type-issues.ts"),
    import("./plugins/import-graph.ts"),
  ]);
  for (const mod of mods) {
    registerPlugin(mod.default);
  }
}

let loaded = false;

export async function ensurePluginsLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  await loadBuiltins();
}
