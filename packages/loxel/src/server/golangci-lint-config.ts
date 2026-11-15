/**
 * Finding and reading a project's golangci-lint config, shared by format on save and the lint
 * server. Reading only: nothing here runs anything.
 */
import { statSync } from "node:fs";
import { basename, join } from "node:path";

import { isRecord } from "@/lib/is-record";

import { readConfigFile } from "./config-file-read";
import { dirsUpToRoot } from "./language-formatter";
import { logger } from "./logger";
import { parseToml } from "./toml-file";

const log = logger.child("server");

/** golangci-lint's config names, in the order it prefers them within a directory. */
const GOLANGCI_CONFIG_FILES = [
  ".golangci.json",
  ".golangci.toml",
  ".golangci.yaml",
  ".golangci.yml",
];

/** A config with more keys than this, counting repeats through YAML aliases, is not read. */
const MAX_CONFIG_NODES = 100_000;
/** Nor one nested deeper, which also ends a YAML alias that contains itself. */
const MAX_CONFIG_DEPTH = 64;

const YAML_AMBIGUOUS_CHARACTERS = /[\u0085\u2028\u2029\uFEFF\uFFFD]/;
/** A `!` where a tag can start: in a quoted string, as in `"!$test"`, it is only text. */
const YAML_TAG = /(?:^|[\s[{,:-])!/;

/** Output destinations that are not files. */
const STANDARD_STREAMS: ReadonlySet<unknown> = new Set(["stdout", "stderr"]);

/** Custom formatters' settings, in the form {@link configKeyParts} gives. */
const CUSTOM_FORMATTER_KEY = ["formatters", "settings", "custom"] as const;

/** Key paths whose settings Loxel does not run, in the form {@link configKeyParts} gives. */
const CUSTOM_LINTER_KEYS = [
  ["linters", "settings", "custom"],
  ["linters-settings", "custom"],
  CUSTOM_FORMATTER_KEY,
] as const;

/** What a config means for running `golangci-lint run` on it. */
export type GolangciConfigVerdict = "runnable" | "unreadable" | "custom" | "v1";

/** What a config means for running `golangci-lint fmt` on it. */
export type GolangciFormatVerdict = Exclude<GolangciConfigVerdict, "v1">;

export function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/** The config golangci-lint would take from `dir`. */
export function golangciConfigIn(dir: string): string | undefined {
  return GOLANGCI_CONFIG_FILES.map((name) => join(dir, name)).find(isFile);
}

/** The nearest config from `dir` up to `wtRoot`: golangci-lint never merges them. */
export function findGolangciConfig(dir: string, wtRoot: string): string | undefined {
  return dirsUpToRoot(dir, wtRoot).map(golangciConfigIn).find(Boolean);
}

export function isGolangciConfigFile(path: string): boolean {
  return GOLANGCI_CONFIG_FILES.includes(basename(path));
}

/** The config's top-level table, or undefined when it is unreadable. */
export function readGolangciConfig(path: string): Record<string, unknown> | undefined {
  const text = readConfigFile(path);
  if (text === undefined) return undefined;
  if (path.endsWith(".toml")) return parseToml(text);
  try {
    const parsed: unknown = path.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch (err) {
    log.debug("Could not read golangci-lint config", { path, error: err });
    return undefined;
  }
}

/**
 * Whether YAML `text` uses something that golangci-lint's parser may read differently from this
 * one: tags and directives, line breaks other than CR and LF, a byte order mark past the start, and
 * text that is not UTF-8. Real configs have no need of them. A full-line comment may say anything
 * except for its characters, since only a line break ends it.
 */
function hasAmbiguousYaml(text: string): boolean {
  if (text.includes("\0") || YAML_AMBIGUOUS_CHARACTERS.test(text.replace(/^\uFEFF/, ""))) {
    return true;
  }
  return text
    .split(/\r\n|\n|\r/)
    .some((line) => !/^\s*#/.test(line) && (YAML_TAG.test(line) || line.startsWith("%")));
}

/**
 * Whether the config at `path` can be run as it is. Anything this cannot read counts as not
 * runnable, as does a config with custom linters or an output file, in any spelling golangci-lint
 * reads (see {@link configKeyParts}).
 */
export function judgeGolangciConfig(path: string): GolangciConfigVerdict {
  const leaves = readConfigLeaves(path);
  if (!leaves) return "unreadable";
  if (leaves.some(isCustomLinterKey) || leaves.some(isOutputFile)) return "custom";
  const version = leaves.find(({ keys }) => keys.length === 1 && keys[0] === "version");
  return String(version?.value) === "2" ? "runnable" : "v1";
}

/**
 * Whether the config at `path` can be formatted with, read as {@link judgeGolangciConfig} reads it.
 * golangci-lint v2 has no custom formatters: `fmt` builds only its own and loads none of the custom
 * linters that `run` does. A config with settings for them counts as `custom` anyway, as for the
 * lint run, so that a release adding them cannot load code through format on save.
 */
export function judgeGolangciFormatConfig(path: string): GolangciFormatVerdict {
  const leaves = readConfigLeaves(path);
  if (!leaves) return "unreadable";
  return leaves.some(({ keys }) => hasPrefix(keys, CUSTOM_FORMATTER_KEY)) ? "custom" : "runnable";
}

/** The config's leaves ({@link configLeaves}), or null when it cannot be read as golangci-lint would. */
function readConfigLeaves(path: string): ConfigLeaf[] | null {
  const config = readGolangciConfig(path);
  if (!config) return null;
  if (!path.endsWith(".toml") && !path.endsWith(".json")) {
    if (hasAmbiguousYaml(readConfigFile(path) ?? "")) return null;
  }
  return configLeaves(config);
}

interface ConfigLeaf {
  keys: readonly string[];
  value: unknown;
}

/**
 * A config key as golangci-lint reads it: a dot nests, whatever the format, and case does not
 * matter, under Go's rules. Those fold U+017F to `s`, and lower U+0130 to a plain `i` where
 * JavaScript adds a combining dot.
 */
function configKeyParts(key: string): string[] {
  return key
    .toLowerCase()
    .replaceAll("\u017f", "s")
    .replaceAll("\u0307", "")
    .split(".")
    .filter(Boolean);
}

/**
 * Every value in the config with the path of keys leading to it, or null past
 * {@link MAX_CONFIG_NODES} or {@link MAX_CONFIG_DEPTH}. A list adds nothing to the path, and a YAML
 * merge key the parser left in place counts as merged.
 */
function configLeaves(config: Record<string, unknown>): ConfigLeaf[] | null {
  const leaves: ConfigLeaf[] = [];
  const stack: (ConfigLeaf & { depth: number })[] = [{ keys: [], value: config, depth: 0 }];
  let nodes = 0;
  for (let next = stack.pop(); next; next = stack.pop()) {
    if (++nodes > MAX_CONFIG_NODES || next.depth > MAX_CONFIG_DEPTH) return null;
    const { keys, value, depth } = next;
    if (Array.isArray(value)) {
      if (value.length === 0) leaves.push(next);
      for (const item of value) stack.push({ keys, value: item, depth: depth + 1 });
    } else if (isRecord(value)) {
      const entries = Object.entries(value);
      if (entries.length === 0) leaves.push(next);
      for (const [key, child] of entries) {
        const parts = key.trim() === "<<" ? [] : configKeyParts(key);
        stack.push({ keys: [...keys, ...parts], value: child, depth: depth + 1 });
      }
    } else {
      leaves.push(next);
    }
  }
  return leaves;
}

function isCustomLinterKey({ keys }: ConfigLeaf): boolean {
  return CUSTOM_LINTER_KEYS.some((prefix) => hasPrefix(keys, prefix));
}

function hasPrefix(keys: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((part, index) => keys[index] === part);
}

function isOutputFile({ keys, value }: ConfigLeaf): boolean {
  return keys[0] === "output" && keys.includes("path") && !STANDARD_STREAMS.has(value);
}
