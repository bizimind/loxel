import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { $ } from "bun";

import { findJars, parsePomProperties, parseWrappedBundle } from "./jar-coordinates";

describe("parsePomProperties", () => {
  test("reads the coordinates", () => {
    const text =
      "#Created by Maven\nartifactId=guava\ngroupId=com.google.guava\nversion=33.7.1-jre\n";
    expect(parsePomProperties(text)).toEqual({
      groupId: "com.google.guava",
      artifactId: "guava",
      version: "33.7.1-jre",
    });
  });

  test("is undefined when one is missing", () => {
    expect(parsePomProperties("groupId=x\nversion=1\n")).toBeUndefined();
  });
});

describe("parseWrappedBundle", () => {
  test("reads the header across a continuation line", () => {
    const manifest =
      "Bundle-Name: JUnit\r\nEclipse-Wrapped-Bundle: junit:junit:4.1\r\n 3.2\r\nX: y\r\n";
    expect(parseWrappedBundle(manifest)).toEqual({
      groupId: "junit",
      artifactId: "junit",
      version: "4.13.2",
    });
  });

  test("is undefined without the header", () => {
    expect(parseWrappedBundle("Bundle-SymbolicName: org.eclipse.core.runtime\n")).toBeUndefined();
  });
});

describe("findJars", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jar-coordinates-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Zips `files` (path to contents) into `jar`. */
  async function makeJar(jar: string, files: Record<string, string | Uint8Array>): Promise<void> {
    const content = mkdtempSync(path.join(dir, "content-"));
    for (const [file, data] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(content, file)), { recursive: true });
      writeFileSync(path.join(content, file), data);
    }
    mkdirSync(path.dirname(jar), { recursive: true });
    await $`zip -qr ${jar} .`.cwd(content);
  }

  test("reads pom.properties, the wrapped-bundle header and nested jars", async () => {
    const staged = path.join(dir, "staged");
    const plugins = path.join(staged, "jdtls", "plugins");
    await makeJar(path.join(plugins, "guava.jar"), {
      "META-INF/maven/com.google.guava/guava/pom.properties":
        "groupId=com.google.guava\nartifactId=guava\nversion=33.7.1-jre\n",
    });
    await makeJar(path.join(plugins, "junit.jar"), {
      "META-INF/MANIFEST.MF": "Eclipse-Wrapped-Bundle: junit:junit:4.13.2\n",
    });
    const nested = path.join(dir, "httpcore.jar");
    await makeJar(nested, {
      "META-INF/maven/org.apache.httpcomponents/httpcore/pom.properties":
        "groupId=org.apache.httpcomponents\nartifactId=httpcore\nversion=4.4.16\n",
    });
    await makeJar(path.join(plugins, "runtime.jar"), {
      "META-INF/MANIFEST.MF": "Bundle-SymbolicName: org.eclipse.m2e.maven.runtime\n",
      "jars/httpcore.jar": await Bun.file(nested).bytes(),
    });
    const jars = await findJars(staged);
    expect(jars.map(({ file, coordinates }) => [file, coordinates])).toEqual([
      [
        path.join("jdtls", "plugins", "guava.jar"),
        [{ groupId: "com.google.guava", artifactId: "guava", version: "33.7.1-jre" }],
      ],
      [
        path.join("jdtls", "plugins", "junit.jar"),
        [{ groupId: "junit", artifactId: "junit", version: "4.13.2" }],
      ],
      [
        path.join("jdtls", "plugins", "runtime.jar"),
        [{ groupId: "org.apache.httpcomponents", artifactId: "httpcore", version: "4.4.16" }],
      ],
    ]);
  });
});
