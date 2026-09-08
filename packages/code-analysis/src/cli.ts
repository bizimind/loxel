#!/usr/bin/env bun
import { resolve } from "node:path";

import { createResult, formatTable, runAction } from "@bizimind/cli-common";
import { program } from "commander";

import { resolveArgs } from "./plugin.ts";
import { ensurePluginsLoaded, listPlugins, loadPlugin } from "./registry.ts";
import { findFreePort, serve } from "./serve.ts";
import { getCurrentVersion } from "./version.ts";

program
  .name("code-analysis")
  .description("Live code visualization — treemaps, network graphs, and more")
  .version(getCurrentVersion());

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

program
  .command("list")
  .description("List all available analysis plugins")
  .option("-j, --json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    await ensurePluginsLoaded();
    const plugins = listPlugins();
    await runAction(opts, async () =>
      createResult(
        plugins.map((p) => ({
          id: p.meta.id,
          description: p.meta.description,
          vizType: p.meta.vizType,
          options: p.meta.options ?? [],
        })),
        (rows) =>
          formatTable(
            rows.map((p) => ({
              plugin: p.id,
              viz: p.vizType,
              description: p.description,
              args: p.options.length
                ? p.options.map((o) => o.key + (o.default ? `=${o.default}` : "")).join(", ")
                : "—",
            })),
            [
              { key: "plugin", label: "Plugin" },
              { key: "viz", label: "Viz" },
              { key: "description", label: "Description" },
              { key: "args", label: "Args" },
            ],
          ),
      ),
    );
  });

// ---------------------------------------------------------------------------
// help <plugin>
// ---------------------------------------------------------------------------

program
  .command("help <plugin>")
  .description("Show detailed help and options for a plugin")
  .action(async (pluginId: string) => {
    await ensurePluginsLoaded();

    let plugin;
    try {
      plugin = await loadPlugin(pluginId);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }

    if (!plugin) {
      process.stderr.write(`Unknown plugin: "${pluginId}"\n`);
      process.exit(1);
    }

    const lines: string[] = [
      `Plugin:        ${plugin.meta.id}`,
      `Description:   ${plugin.meta.description}`,
      `Visualization: ${plugin.meta.vizType}`,
    ];

    const opts = plugin.meta.options ?? [];
    if (opts.length === 0) {
      lines.push("", "No options.");
    } else {
      lines.push("", "Options:");
      const keyW = Math.max(...opts.map((o) => o.key.length)) + 2;
      for (const o of opts) {
        const tag = o.required
          ? "[required]"
          : o.default !== undefined
            ? `[default: ${o.default}]`
            : "[optional]";
        lines.push(`  --arg ${o.key.padEnd(keyW)}  ${o.description}  ${tag}`);
      }
    }

    process.stdout.write(lines.join("\n") + "\n");
  });

// ---------------------------------------------------------------------------
// run (default)
// ---------------------------------------------------------------------------

program
  .command("run", { isDefault: true })
  .description(
    "Run an analysis and print results. Use --web to serve an interactive visualization.",
  )
  .requiredOption("-p, --plugin <plugin>", "Plugin id, path (./my-plugin.ts), or npm package")
  .option("-w, --workdir <path>", "Working directory (default: cwd)")
  .option(
    "-a, --arg <pair>",
    "Plugin argument as key=value (repeatable, e.g. -a rule=no-console)",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option("--web", "Serve an interactive visualization instead of printing results")
  .option(
    "--port <number>",
    "Web server port, only used with --web (default: random free port)",
    "0",
  )
  .option("-j, --json", "Output results as JSON")
  .action(
    async (opts: {
      plugin: string;
      workdir?: string;
      arg: string[];
      web?: boolean;
      port: string;
      json?: boolean;
    }) => {
      await ensurePluginsLoaded();

      let plugin;
      try {
        plugin = await loadPlugin(opts.plugin);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }

      if (!plugin) {
        const ids = listPlugins()
          .map((p) => p.meta.id)
          .join(", ");
        process.stderr.write(`Unknown plugin: "${opts.plugin}"\nAvailable: ${ids}\n`);
        process.exit(1);
      }

      // Parse -a key=value pairs
      const rawArgs: Record<string, string> = {};
      for (const pair of opts.arg) {
        const eq = pair.indexOf("=");
        if (eq === -1) {
          process.stderr.write(`Invalid --arg format: "${pair}" (expected key=value)\n`);
          process.exit(1);
        }
        rawArgs[pair.slice(0, eq)] = pair.slice(eq + 1);
      }

      // Apply defaults and validate required options
      const args = resolveArgs(plugin, rawArgs);

      const workDir = resolve(opts.workdir ?? process.cwd());

      if (opts.web) {
        const rawPort = parseInt(opts.port, 10);
        const port = rawPort === 0 ? await findFreePort() : rawPort;

        await runAction(opts, async () =>
          createResult(
            {
              plugin: plugin.meta.id,
              vizType: plugin.meta.vizType,
              args,
              workDir,
              url: `http://localhost:${port}`,
            },
            (d) => d.url,
          ),
        );

        await serve({ plugin, workDir, args, port });
      } else {
        const records = await plugin.generate(workDir, args);
        const config = plugin.buildConfig(workDir, args);

        await runAction(opts, async () =>
          createResult(records, (rows) => {
            const valueField = config.vizType === "treemap" ? config.valueField : null;
            const unit = config.vizType === "treemap" ? config.unit : null;
            const sorted = valueField
              ? [...rows].sort(
                  (a, b) => ((b[valueField] as number) ?? 0) - ((a[valueField] as number) ?? 0),
                )
              : rows;
            const columns: Array<{
              key: keyof (typeof rows)[0];
              label: string;
              align?: "left" | "right";
            }> = [{ key: "path", label: "Path" }];
            if (valueField) {
              columns.push({
                key: valueField as keyof (typeof rows)[0],
                label: unit ?? valueField,
                align: "right",
              });
            }
            return formatTable(sorted, columns);
          }),
        );
      }
    },
  );

if (process.argv.length === 2) {
  program.help();
}

program.parseAsync().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
