/**
 * Reads the Maven coordinates of the jars a language server ships (jdtls's plugins), as scanners
 * do: from each `META-INF/maven/<group>/<artifact>/pom.properties` in the jar, or, for a bundle
 * Eclipse rewrapped, its manifest's `Eclipse-Wrapped-Bundle: <group>:<artifact>:<version>`. A jar
 * with neither, such as Eclipse's own bundles, has no Maven identity and is part of its server.
 * Jars nested in a jar (`m2e.maven.runtime` embeds Maven's) are read too. Uses `unzip`.
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

/** The coordinates in a manifest's `Eclipse-Wrapped-Bundle` header (continuation lines joined). */
export function parseWrappedBundle(manifest: string): MavenCoordinates | undefined {
  const unfolded = manifest.replaceAll(/\r?\n /g, "");
  const match = /^Eclipse-Wrapped-Bundle:\s*([^:\s]+):([^:\s]+):(\S+)\s*$/m.exec(unfolded);
  if (!match) return undefined;
  const [, groupId = "", artifactId = "", version = ""] = match;
  return { groupId, artifactId, version };
}

/** The coordinates of the jar at `file` and of the jars nested in it. */
export async function jarCoordinates(file: string): Promise<MavenCoordinates[]> {
  const entries = (await $`unzip -Z1 ${file}`.quiet().text()).split("\n");
  const found: MavenCoordinates[] = [];
  for (const entry of entries.filter((name) => POM_PROPERTIES.test(name))) {
    const coordinates = parsePomProperties(await $`unzip -p ${file} ${entry}`.quiet().text());
    if (coordinates) found.push(coordinates);
  }
  if (found.length === 0 && entries.includes("META-INF/MANIFEST.MF")) {
    const wrapped = parseWrappedBundle(await $`unzip -p ${file} META-INF/MANIFEST.MF`.text());
    if (wrapped) found.push(wrapped);
  }
  const nested = entries.filter((name) => name.endsWith(".jar"));
  if (nested.length === 0) return found;
  const dir = mkdtempSync(path.join(os.tmpdir(), "loxel-jar-"));
  try {
    await $`unzip -q -o ${file} ${nested} -d ${dir}`.quiet();
    for (const name of nested) found.push(...(await jarCoordinates(path.join(dir, name))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return found;
}

/** Each jar under `dir`, recursively, with its path relative to `dir` and its coordinates. */
export async function findJars(
  dir: string,
): Promise<Array<{ file: string; coordinates: MavenCoordinates[] }>> {
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".jar"))
    .toSorted();
  const jars: Array<{ file: string; coordinates: MavenCoordinates[] }> = [];
  // One at a time: each jar runs a few `unzip`s.
  for (const file of files) {
    jars.push({ file, coordinates: await jarCoordinates(path.join(dir, file)) });
  }
  return jars;
}
