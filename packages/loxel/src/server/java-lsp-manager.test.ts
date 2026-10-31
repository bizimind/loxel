import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  dropUnusableActions,
  dropWillRename,
  firstJavaFile,
  indentationOf,
  JAVA_SETTINGS,
  jdtlsArgs,
  jdtlsDataDir,
  latestLogMessage,
} from "./java-lsp-manager";
import { fileUri } from "./lsp-file-uri";

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

describe("firstJavaFile", () => {
  const root = path.join(scratch, "scan");
  mkdirSync(path.join(root, "node_modules/x"), { recursive: true });
  mkdirSync(path.join(root, ".hidden"), { recursive: true });
  writeFileSync(path.join(root, "node_modules/x/Skipped.java"), "");
  writeFileSync(path.join(root, ".hidden/Skipped.java"), "");

  test("skips dependency and hidden folders, and finds nothing there", async () => {
    expect(await firstJavaFile(root)).toBeNull();
  });

  test("finds a source file, the shallowest first", async () => {
    mkdirSync(path.join(root, "src/deep/er"), { recursive: true });
    writeFileSync(path.join(root, "src/deep/er/Deep.java"), "");
    writeFileSync(path.join(root, "src/Top.java"), "");
    expect(await firstJavaFile(root)).toBe(fileUri(path.join(root, "src/Top.java")));
  });

  test("treats an unreadable or missing folder as empty", async () => {
    expect(await firstJavaFile(path.join(root, "missing"))).toBeNull();
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
    expect(latestLogMessage(dir, 0)).toBe("last");
  });

  test("has no answer without a readable log", () => {
    expect(latestLogMessage(path.join(scratch, "nowhere"), 0)).toBeNull();
  });

  test("ignores logs from before this run", () => {
    const dir = path.join(scratch, "old-logs");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "1.log"), "!MESSAGE old\n");
    utimesSync(path.join(dir, "1.log"), 1, 1);
    expect(latestLogMessage(dir, 5000)).toBeNull();
  });
});
