import { describe, expect, test } from "bun:test";

import * as monaco from "monaco-editor";

// As jdtls 1.63 writes them. It accepts Monaco's re-encoding of these and answers with the same
// document (measured), so a model's URI is what goes to the server.
const JDT_URIS = [
  "jdt://contents/java.base/java.util/List.java?=fix_4e54da2a/%5C/Users%5C/me%5C/jdk%5C/jdk-25.0.5+8%5C/lib%5C/jrt-fs.jar%60java.base=/javadoc_location=/https:%5C/%5C/docs.oracle.com%5C/en%5C/java%5C/=/%3Cjava.util%28List.class",
  "jdt://contents/guava-33.6.0-jre.jar/com.google.common.collect/ImmutableList.java?=fix_4e54da2a/%5C/tmp%5C/fix%5C/lib%5C/guava-33.6.0-jre.jar%3Ccom.google.common.collect%28ImmutableList.class",
];

describe("jdt:// URIs", () => {
  test("keep their meaning through Monaco's canonical form, so answers match the model", () => {
    for (const raw of JDT_URIS) {
      const parsed = monaco.Uri.parse(raw);
      expect(parsed.scheme).toBe("jdt");
      const canonical = parsed.toString();
      expect(monaco.Uri.parse(canonical).query).toBe(parsed.query);
      expect(monaco.Uri.parse(canonical).toString()).toBe(canonical);
    }
  });
});
