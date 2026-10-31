import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  dropUnusableActions,
  dropWillRename,
  indentationOf,
  JAVA_SETTINGS,
  jdtlsArgs,
  jdtlsDataDir,
  latestLogMessage,
} from "./java-lsp-manager";

const scratch = mkdtempSync(path.join(tmpdir(), "java-lsp-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("JAVA_SETTINGS", () => {
  test("starts with project import off", () => {
    expect(JAVA_SETTINGS.import.maven.enabled).toBe(false);
    expect(JAVA_SETTINGS.import.gradle.enabled).toBe(false);
    expect(JAVA_SETTINGS.import.exclusions).toEqual(["**"]);
    expect(JAVA_SETTINGS.autobuild.enabled).toBe(false);
  });
});

describe("jdtlsArgs", () => {
  const home = path.join(scratch, "jdtls");
  mkdirSync(path.join(home, "plugins"), { recursive: true });
  writeFileSync(path.join(home, "plugins", "org.eclipse.equinox.launcher_1.jar"), "");

  test("runs the launcher jar with the state directories and no name resolution", () => {
    const args = jdtlsArgs({ home, configuration: "/c", data: "/d", hosts: "/h" });
    expect(args).toContain("-Djdk.net.hosts.file=/h");
    expect(args).toContain("-Djava.import.generatesMetadataFilesAtProjectRoot=false");
    expect(args.slice(-5)).toEqual([
      path.join(home, "plugins", "org.eclipse.equinox.launcher_1.jar"),
      "-configuration",
      "/c",
      "-data",
      "/d",
    ]);
  });

  test("fails on an incomplete install", () => {
    const empty = path.join(scratch, "empty");
    mkdirSync(path.join(empty, "plugins"), { recursive: true });
    expect(() => jdtlsArgs({ home: empty, configuration: "", data: "", hosts: "" })).toThrow();
  });
});

test("jdtlsDataDir keeps same-named worktrees apart", () => {
  expect(jdtlsDataDir("/a/project")).not.toBe(jdtlsDataDir("/b/project"));
  expect(jdtlsDataDir("/a/project")).toBe(jdtlsDataDir("/a/project"));
});

describe("dropWillRename", () => {
  test("removes the capability and keeps the rest of the initialize response", () => {
    const fileOperations: Record<string, unknown> = { willRename: { filters: [] }, didCreate: {} };
    const message = { result: { capabilities: { workspace: { fileOperations } } } };
    expect(dropWillRename(message)).toBe(true);
    expect(fileOperations).toEqual({ didCreate: {} });
  });

  test("leaves other messages alone", () => {
    expect(dropWillRename({ result: { contents: "willRename" } })).toBe(false);
    expect(dropWillRename({ method: "window/logMessage" })).toBe(false);
  });
});

describe("dropUnusableActions", () => {
  test("removes actions Loxel cannot carry out", () => {
    const message = {
      result: [
        { title: "Organize imports", kind: "source.organizeImports" },
        { title: "Ignore compiler problem(s)", kind: "quickfix" },
        { title: "Change signature", command: { command: "java.action.applyRefactoringCommand" } },
      ],
    };
    expect(dropUnusableActions(message)).toBe(true);
    expect(message.result).toEqual([{ title: "Organize imports", kind: "source.organizeImports" }]);
  });

  test("leaves a response with nothing to drop", () => {
    expect(dropUnusableActions({ result: [{ title: "Extract to field" }] })).toBe(false);
    expect(dropUnusableActions({ result: { items: [] } })).toBe(false);
  });
});

describe("indentationOf", () => {
  test("reads spaces and tabs from the first indented line", () => {
    expect(indentationOf("class A {\n  int a;\n}\n")).toEqual({ tabSize: 2, insertSpaces: true });
    expect(indentationOf("class A {\n\tint a;\n}\n")).toEqual({ tabSize: 4, insertSpaces: false });
  });

  test("skips the continuation lines of comments", () => {
    const text = "/**\n * Doc\n */\nclass A {\n    int a;\n}\n";
    expect(indentationOf(text)).toEqual({ tabSize: 4, insertSpaces: true });
  });

  test("has no answer for a file with no indentation", () => {
    expect(indentationOf("class A {}\n")).toBeNull();
  });
});

describe("latestLogMessage", () => {
  test("returns the last message of the newest log", () => {
    const dir = path.join(scratch, "logs");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "1.log"), "!MESSAGE old\n");
    utimesSync(path.join(dir, "1.log"), 1, 1);
    writeFileSync(path.join(dir, "2.log"), "!ENTRY x\n!MESSAGE first\n!MESSAGE last\nstack\n");
    expect(latestLogMessage(dir)).toBe("last");
  });

  test("has no answer without a readable log", () => {
    expect(latestLogMessage(path.join(scratch, "nowhere"))).toBeNull();
  });
});
