import { describe, expect, test } from "bun:test";

import type { JavaRuntime } from "@/api/java-env-model";

import { javaRuntimeLabel } from "./java-runtime";

function runtime(implementor: string | null): JavaRuntime {
  return { path: "/jdk", majorVersion: 21, version: "21.0.5", implementor };
}

describe("javaRuntimeLabel", () => {
  test("shows the version and the distribution's own name", () => {
    expect(javaRuntimeLabel(runtime("Eclipse Adoptium"))).toBe("Java 21.0.5 (Temurin)");
    expect(javaRuntimeLabel(runtime("Amazon.com Inc."))).toBe("Java 21.0.5 (Corretto)");
  });

  test("falls back to the implementor, or nothing", () => {
    expect(javaRuntimeLabel(runtime("Some Vendor"))).toBe("Java 21.0.5 (Some Vendor)");
    expect(javaRuntimeLabel(runtime(null))).toBe("Java 21.0.5");
  });
});
