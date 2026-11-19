/**
 * Orchestrates schema synchronization between the settings store,
 * Monaco's JSON language service, and the YAML and TOML language servers.
 *
 * Settings are synced on initial load (after settings hydrate) and on settings save. Downloads
 * follow the open files: a configured schema is fetched when a file first matches its glob, and
 * URLs a file names are reported so the server can fetch or ask about them.
 */
import * as monaco from "monaco-editor";

import * as api from "@/api/client";
import { localServerId, whenLocalServerKnown } from "@/api/local-server";
import type { ServerId } from "@/api/worktree-ref";
import { useSchemaConsentStore } from "@/store/schema-consent";
import {
  selectEffectiveSchemas,
  useSettingsStore,
  type SchemaMapping,
} from "@/store/settings-store";

import { frontendLog } from "./frontend-logger";
import { setConfiguredSchemas } from "./json-schema-registry";
import { editorFile, isLiveEditorModel } from "./live-editor-model";
import { classifySchemaGlob, schemaExcludeGlob, schemaFilePatterns } from "./schema-glob";
import { isRemoteSchemaUrl, schemaGlobMatches, schemaUrlsNamedBy } from "./schema-references";

const log = frontendLog.child("ui");

let syncing = false;
let pendingSync = false;

/** Enabled mappings as of the last sync. */
let mappings: SchemaMapping[] = [];
/** JSON schemas resolved so far, with `null` for one that failed. */
const jsonSchemas = new Map<string, unknown>();
/** URLs already reported, so an edit does not retry a failed download. */
const reportedUrls = new Set<string>();

/**
 * The server that downloads and serves schemas: the window's own, which keeps the window's
 * settings and the schema cache its language servers read.
 */
function schemaServer(): ServerId {
  return localServerId();
}

function applyJsonSchemas(): void {
  setConfiguredSchemas(
    mappings.flatMap((mapping) => {
      const schema = jsonSchemas.get(mapping.url);
      if (schema === undefined || schema === null) return [];
      return [{ fileMatch: schemaFilePatterns(mapping), url: mapping.url, schema }];
    }),
  );
}

/**
 * Fetch what the open files need: configured schemas whose glob they match (JSON through the
 * server into Monaco, TOML into Tombi's cache) and the remote URLs TOML and XML files name.
 */
export function requestSchemasForOpenFiles(): void {
  const jsonUrls = new Set<string>();
  const remoteUrls = new Set<string>();
  for (const model of monaco.editor.getModels()) {
    if (!isLiveEditorModel(model)) continue;
    const path = editorFile(model.uri)?.path;
    if (path === undefined) continue;
    const language = model.getLanguageId();
    for (const url of schemaUrlsNamedBy(language, model.getValue())) remoteUrls.add(url);
    if (language !== "json" && language !== "toml") continue;
    for (const mapping of mappings) {
      const { glob, url } = mapping;
      if (!classifySchemaGlob(glob)[language] || !schemaGlobMatches(glob, path)) continue;
      if (language === "json") {
        const exclude = schemaExcludeGlob(mapping);
        if (exclude === null || !schemaGlobMatches(exclude, path)) jsonUrls.add(url);
        // Tombi applies no exclusions, so a TOML file needs the schema whatever `exclude` says.
      } else if (isRemoteSchemaUrl(url)) remoteUrls.add(url);
    }
  }

  const unresolved = [...jsonUrls].filter((url) => !jsonSchemas.has(url));
  if (unresolved.length > 0) void resolveJsonSchemas(unresolved);

  const unreported = [...remoteUrls].filter((url) => !reportedUrls.has(url));
  if (unreported.length === 0) return;
  for (const url of unreported) reportedUrls.add(url);
  api.ensureSchemas(schemaServer(), unreported).catch((err: unknown) => {
    log.error("Schema request failed", { error: err instanceof Error ? err : undefined });
  });
}

async function resolveJsonSchemas(urls: readonly string[]): Promise<void> {
  for (const url of urls) jsonSchemas.set(url, null);
  await Promise.all(
    urls.map(async (url) => {
      jsonSchemas.set(url, await api.resolveSchema(schemaServer(), url));
    }),
  );
  applyJsonSchemas();
}

/** Send the configured schemas to the server, then fetch what the open files need of them. */
export async function syncSchemas(): Promise<void> {
  if (syncing) {
    pendingSync = true;
    return;
  }
  syncing = true;

  try {
    const schemas = selectEffectiveSchemas(useSettingsStore.getState());
    const enabled = schemas.filter((s) => s.enabled);

    await api.syncSchemas(
      schemaServer(),
      enabled.map((s) => ({ glob: s.glob, exclude: s.exclude, url: s.url })),
    );

    mappings = enabled;
    // A save retries what failed to download.
    for (const [url, schema] of jsonSchemas) if (schema === null) jsonSchemas.delete(url);
    reportedUrls.clear();
    applyJsonSchemas();
    requestSchemasForOpenFiles();
  } catch (err) {
    log.error("Schema sync failed", { error: err instanceof Error ? err : undefined });
  } finally {
    syncing = false;
    if (pendingSync) {
      pendingSync = false;
      syncSchemas();
    }
  }
}

/** Initialize schema sync — call once at module load time. */
export function initSchemaSync(): void {
  // A decision can change what may be downloaded, for files already open.
  useSchemaConsentStore.subscribe(() => {
    reportedUrls.clear();
    requestSchemasForOpenFiles();
  });

  // Wait for the settings store to hydrate, and for the window's server (`schemaServer`), then sync
  const syncOnceKnown = () => void whenLocalServerKnown().then(syncSchemas);
  if (useSettingsStore.persist.hasHydrated()) {
    syncOnceKnown();
  } else {
    useSettingsStore.persist.onFinishHydration(syncOnceKnown);
  }
}
