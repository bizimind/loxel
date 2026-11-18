/**
 * Reads the Maven coordinates of the jars a language server ships (jdtls's plugins), as scanners
 * do: from each `META-INF/maven/<group>/<artifact>/pom.properties` in the jar, or, for a bundle
 * Eclipse rewrapped, its manifest's `Eclipse-Wrapped-Bundle: <group>:<artifact>:<version>`. A jar
 * with neither, such as Eclipse's own bundles, has only its OSGi name and version. Jars nested in
 * a jar (`m2e.maven.runtime` embeds Maven's) are read too. Uses `unzip`.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { $ } from "bun";

export interface MavenCoordinates {
  groupId: string;
  artifactId: string;
  version: string;
}

/** An OSGi bundle's `Bundle-SymbolicName` and `Bundle-Version`. */
export interface OsgiBundle {
  symbolicName: string;
  version: string;
}

export interface Jar {
  /** Relative to the directory searched. */
  file: string;
  coordinates: MavenCoordinates[];
  /** For a jar without coordinates, when its manifest names it. */
  bundle?: OsgiBundle;
}

const POM_PROPERTIES = /^META-INF\/maven\/[^/]+\/[^/]+\/pom\.properties$/;

/** The coordinates in a `pom.properties` file, or undefined when one is missing. */
export function parsePomProperties(text: string): MavenCoordinates | undefined {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (line.startsWith("#") || equals < 0) continue;
    values.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim());
  }
  const groupId = values.get("groupId");
  const artifactId = values.get("artifactId");
  const version = values.get("version");
  if (!groupId || !artifactId || !version) return undefined;
  return { groupId, artifactId, version };
}

/** A manifest header's value, continuation lines joined, without its `;` attributes. */
function manifestHeader(manifest: string, name: string): string | undefined {
  const unfolded = manifest.replaceAll(/\r?\n /g, "");
  const line = unfolded.split(/\r?\n/).find((candidate) => candidate.startsWith(`${name}:`));
  return (
    line
      ?.slice(name.length + 1)
      .split(";")[0]
      ?.trim() || undefined
  );
}

/** The coordinates in a manifest's `Eclipse-Wrapped-Bundle` header. */
export function parseWrappedBundle(manifest: string): MavenCoordinates | undefined {
  const [groupId, artifactId, version, ...rest] =
    manifestHeader(manifest, "Eclipse-Wrapped-Bundle")?.split(":") ?? [];
  if (!groupId || !artifactId || !version || rest.length > 0) return undefined;
  return { groupId, artifactId, version };
}

/** The bundle a manifest names. */
export function parseBundle(manifest: string): OsgiBundle | undefined {
  const symbolicName = manifestHeader(manifest, "Bundle-SymbolicName");
  const version = manifestHeader(manifest, "Bundle-Version");
  return symbolicName && version ? { symbolicName, version } : undefined;
}

/** The jar at `file`, `name` relative to where it was found, with the jars nested in it. */
async function readJar(file: string, name: string): Promise<Jar> {
  const entries = (await $`unzip -Z1 ${file}`.quiet().text()).split("\n");
  const coordinates: MavenCoordinates[] = [];
  for (const entry of entries.filter((entryName) => POM_PROPERTIES.test(entryName))) {
    const found = parsePomProperties(await $`unzip -p ${file} ${entry}`.quiet().text());
    if (found) coordinates.push(found);
  }
  const manifest = entries.includes("META-INF/MANIFEST.MF")
    ? await $`unzip -p ${file} META-INF/MANIFEST.MF`.quiet().text()
    : "";
  const wrapped = coordinates.length === 0 ? parseWrappedBundle(manifest) : undefined;
  if (wrapped) coordinates.push(wrapped);
  // Named by its manifest when the jar itself, not just a jar nested in it, has no coordinates.
  const bundle = coordinates.length === 0 ? parseBundle(manifest) : undefined;
  const nested = entries.filter(
    (entryName) => entryName.endsWith(".jar") && !entryName.includes(".."),
  );
  if (nested.length > 0) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "loxel-jar-"));
    try {
      await $`unzip -q -o ${file} ${"*.jar"} -d ${dir}`.quiet();
      for (const entry of nested) {
        coordinates.push(...(await readJar(path.join(dir, entry), entry)).coordinates);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { file: name, coordinates, ...(bundle && { bundle }) };
}

/** Each jar under `dir`, recursively, with its path relative to `dir`. */
export async function findJars(dir: string): Promise<Jar[]> {
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".jar"))
    .toSorted();
  const jars: Jar[] = [];
  // One at a time: each jar runs a few `unzip`s.
  for (const file of files) jars.push(await readJar(path.join(dir, file), file));
  return jars;
}
