import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { logger } from "./logger";
import { normalizeSchemaUrl, type SchemaVerdict } from "./schema-consent";

const log = logger.child("schema-service");

/** How long a downloaded schema is used before the next use downloads it again. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Files one schema may pull in by reference. */
const MAX_FILES_PER_SCHEMA = 100;
/** What a language server gets for a schema it may not have: one that accepts everything. */
const EMPTY_SCHEMA = "{}";

const XML_REFERENCE_RE = /(?:schemaLocation|SYSTEM|href)\s*=?\s*["']([^"']+)["']/g;

/** The absolute HTTP(S) URLs a JSON Schema, XSD or DTD references, resolved against its URL. */
export function schemaReferences(text: string, url: string): string[] {
  const references = new Set<string>();
  const add = (reference: string): void => {
    if (reference.startsWith("#")) return;
    try {
      const normalized = normalizeSchemaUrl(new URL(reference, url).href);
      if (normalized) references.add(normalized);
    } catch {
      // Not a URL, nothing to fetch.
    }
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: a YAML schema (the server reads its references through the same gate) or XML.
    for (const match of text.matchAll(XML_REFERENCE_RE)) add(match[1]!);
    return [...references];
  }

  const pending: unknown[] = [parsed];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== "object" || node === null) continue;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") add(value);
      else pending.push(value);
    }
  }
  return [...references];
}

/** Tombi's cache file for a URL, at its pinned version (`tombi_cache::cache_file_path`). */
export function tombiCachePath(root: string, url: string): string | null {
  const { protocol, hostname, pathname } = new URL(url);
  const segments = pathname.split("/").filter(Boolean);
  const file = pathname.endsWith(".json") ? [] : ["__index__.json"];
  return confined(root, [protocol.slice(0, -1), hostname, ...segments, ...file]);
}

/** LemMinX's cache file for a URL, at its pinned version (`CacheResourcesManager`). */
export function lemminxCachePath(root: string, url: string): string | null {
  const { protocol, hostname, port, pathname } = new URL(url);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  try {
    return confined(root, [
      "cache",
      protocol.slice(0, -1),
      hostname,
      ...(port ? [port] : []),
      ...segments.map(decodeURIComponent),
    ]);
  } catch {
    return null;
  }
}

/** The path of `segments` under `root`, or null when they would lead out of it. */
function confined(root: string, segments: string[]): string | null {
  const path = resolve(root, ...segments);
  return path.startsWith(resolve(root) + sep) ? path : null;
}

export interface SchemaDownloadsOptions {
  /** Tombi's `TOMBI_CACHE_HOME`. */
  tombiCacheDir: string;
  /** LemMinX's `xml.server.workDir`. */
  lemminxWorkDir: string;
  fetchText: (url: string) => Promise<string | null>;
  request: (url: string) => SchemaVerdict;
  addReferences: (root: string, references: readonly string[]) => void;
  /** Servers that read a schema once must start over to see one that just arrived. */
  restartServers: () => void;
}

/**
 * Downloads the schemas language servers may use, on their behalf. No server reaches the network
 * for a schema itself: yaml-language-server asks for each schema's content, and Tombi and LemMinX
 * run offline, reading only their cache directories, which only this class writes to.
 */
export class SchemaDownloads {
  /** Settles once a running {@link onRevoked} has emptied the caches. */
  private revoking: Promise<unknown> = Promise.resolve();
  /** Downloads under way, so a file opening while one runs does not restart servers twice. */
  private readonly running = new Map<string, Promise<boolean>>();

  constructor(private readonly options: SchemaDownloadsOptions) {}

  /** A schema's content for a server that asks for it; an empty schema when it may not have it. */
  async contentFor(url: string): Promise<string> {
    if (this.options.request(url) !== "allowed") return EMPTY_SCHEMA;
    const text = await this.options.fetchText(url);
    if (text === null) throw new Error(`Could not download ${url}`);
    this.options.addReferences(url, schemaReferences(text, url));
    return text;
  }

  /** Download what open files name or match, restarting the servers when something new arrives. */
  async ensure(urls: readonly string[]): Promise<void> {
    const allowed = urls.filter((url) => this.options.request(url) === "allowed");
    const results = await Promise.all(allowed.map((url) => this.cache(url)));
    if (results.includes(true)) this.options.restartServers();
  }

  /** Download a schema the user just trusted, and have the servers pick it up. */
  async onTrusted(url: string): Promise<void> {
    await this.cache(url);
    this.options.restartServers();
  }

  /** Forget everything downloaded, after the user took a trust decision back. */
  async onRevoked(): Promise<void> {
    this.revoking = Promise.all(
      [this.options.tombiCacheDir, this.options.lemminxWorkDir].map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    ).catch((err: unknown) => {
      log.warn("Could not empty the schema caches", {
        error: err instanceof Error ? err : undefined,
      });
    });
    await this.revoking;
    this.options.restartServers();
  }

  /** Cache `root` once at a time. Resolves to whether this call brought a new file. */
  private async cache(root: string): Promise<boolean> {
    const running = this.running.get(root);
    if (running) {
      await running;
      return false;
    }
    const download = this.download(root).finally(() => this.running.delete(root));
    this.running.set(root, download);
    return download;
  }

  private async download(root: string): Promise<boolean> {
    await this.revoking;
    const queue = [root];
    const seen = new Set(queue);
    let arrived = false;
    while (queue.length > 0 && seen.size <= MAX_FILES_PER_SCHEMA) {
      const url = queue.shift()!;
      const paths = this.cachePaths(url);
      if (paths.length === 0) continue;
      const age = await cacheAge(paths);
      if (age !== null && age < CACHE_TTL_MS) continue;

      const text = await this.options.fetchText(url);
      if (text === null) continue;
      await writeAll(paths, text);
      if (age === null) arrived = true;

      const references = schemaReferences(text, url);
      this.options.addReferences(root, references);
      for (const reference of references) {
        if (seen.has(reference) || this.options.request(reference) !== "allowed") continue;
        seen.add(reference);
        queue.push(reference);
      }
    }
    return arrived;
  }

  private cachePaths(url: string): string[] {
    return [
      tombiCachePath(this.options.tombiCacheDir, url),
      lemminxCachePath(this.options.lemminxWorkDir, url),
    ].flatMap((path) => path ?? []);
  }
}

/** Milliseconds since the oldest of `paths` was written; null when one is missing. */
async function cacheAge(paths: readonly string[]): Promise<number | null> {
  try {
    const stats = await Promise.all(paths.map((path) => stat(path)));
    return Date.now() - Math.min(...stats.map((s) => s.mtimeMs));
  } catch {
    return null;
  }
}

async function writeAll(paths: readonly string[], text: string): Promise<void> {
  try {
    await Promise.all(
      paths.map(async (path) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text);
      }),
    );
  } catch (err) {
    log.warn("Could not cache a schema", { error: err instanceof Error ? err : undefined });
  }
}
