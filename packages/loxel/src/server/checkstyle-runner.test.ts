import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CheckstyleError,
  configTabWidth,
  failureMessage,
  localConfig,
  namesUnproxiedUrl,
  parseCheckstyleXml,
  propertiesFileText,
  stoppedAtFile,
  toDiagnostic,
} from "./checkstyle-runner";

// The samples have the shapes measured from Checkstyle 14.3.0, and the same from 8.39 to 13.0.0.

const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<checkstyle version="14.3.0">
<file name="/w/A.java">
<error line="2" column="8" severity="warning" message="Unused import - java.util.List." source="com.puppycrawl.tools.checkstyle.checks.imports.UnusedImportsCheck"/>
<error line="5" severity="info" message="Name &apos;a&apos; &amp; &lt;b&gt;&#10;next" source="com.puppycrawl.tools.checkstyle.checks.sizes.LineLengthCheck"/>
</file>
<file name="/w/B.java">
</file>
<file name="/elsewhere/C.java">
<error line="1" severity="error" message="not asked about" source="x"/>
</file>
</checkstyle>
`;

describe("parseCheckstyleXml", () => {
  test("errors by file, a file with none included", () => {
    const report = parseCheckstyleXml(REPORT, ["/w/A.java", "/w/B.java"]);
    expect(report?.errors.get("/w/B.java")).toEqual([]);
    expect(report?.errors.has("/elsewhere/C.java")).toBe(false);
    expect(report?.errors.get("/w/A.java")).toEqual([
      {
        line: 2,
        column: 8,
        severity: "warning",
        message: "Unused import - java.util.List.",
        source: "com.puppycrawl.tools.checkstyle.checks.imports.UnusedImportsCheck",
      },
      {
        line: 5,
        column: null,
        severity: "info",
        message: "Name 'a' & <b>\nnext",
        source: "com.puppycrawl.tools.checkstyle.checks.sizes.LineLengthCheck",
      },
    ]);
  });

  test("no report: a config that didn't load", () => {
    expect(parseCheckstyleXml("", ["/w/A.java"])).toBeNull();
    expect(parseCheckstyleXml('<checkstyle version="1">\n', ["/w/A.java"])).toBeNull();
  });

  test("a name relative to a config's basedir matches the file it was given", () => {
    const xml = `<checkstyle><file name="src/A.java"></file></checkstyle>`;
    expect(parseCheckstyleXml(xml, ["/w/src/A.java"])?.errors.has("/w/src/A.java")).toBe(true);
  });
});

test("stoppedAtFile names the file a run ended on", () => {
  const stderr = `Picked up JAVA_TOOL_OPTIONS: -Dx=y
com.puppycrawl.tools.checkstyle.api.CheckstyleException: Exception was thrown while processing /w/B.java
\tat com.puppycrawl.tools.checkstyle.Checker.processFiles(Checker.java:303)
Checkstyle ends with 1 errors.`;
  expect(stoppedAtFile(stderr, ["/w/A.java", "/w/B.java"])).toBe("/w/B.java");
  expect(stoppedAtFile("Checkstyle ends with 2 errors.", ["/w/A.java"])).toBeNull();
});

describe("failureMessage", () => {
  const exit = (stderr: string) => ({ stderr, stdout: "", exitCode: 254 });

  test("the deepest exception's message, without the JVM's lines", () => {
    expect(
      failureMessage(
        exit(`Picked up JAVA_TOOL_OPTIONS: -Dx=y
com.puppycrawl.tools.checkstyle.api.CheckstyleException: unable to parse configuration stream
\tat com.puppycrawl.tools.checkstyle.ConfigurationLoader.loadConfiguration(ConfigurationLoader.java:313)
Caused by: org.xml.sax.SAXException: com.puppycrawl.tools.checkstyle.api.CheckstyleException: Property \${m} has not been set
\t... 5 more
Checkstyle ends with 1 errors.`),
      ),
    ).toBe("Property ${m} has not been set");
  });

  test("a check that's gone, without the advice after it", () => {
    expect(
      failureMessage(
        exit(
          "Caused by: com.puppycrawl.tools.checkstyle.api.CheckstyleException: Unable to instantiate 'JavadocStyle' class, it is also not possible to instantiate it as .JavadocStyle. Please recheck that class name is specified as canonical name.",
        ),
      ),
    ).toBe(
      "Unable to instantiate 'JavadocStyle' class, it is also not possible to instantiate it as .JavadocStyle.",
    );
  });

  test("a URL that went nowhere, a plain message, and nothing at all", () => {
    expect(failureMessage(exit("java.net.ConnectException: Connection refused"))).toContain(
      "names a URL",
    );
    expect(failureMessage(exit("Could not find config XML file 'x.xml'."))).toBe(
      "Could not find config XML file 'x.xml'.",
    );
    expect(failureMessage(exit(""))).toBe("it ended with exit code 254 and no message.");
    expect(failureMessage({ stderr: "", stdout: "", exitCode: null })).toContain("a signal");
  });

  test("a long one is cut", () => {
    expect(failureMessage(exit("x".repeat(2000))).length).toBe(601);
  });
});

describe("toDiagnostic", () => {
  const error = (over: Partial<CheckstyleError>): CheckstyleError => ({
    line: 1,
    column: null,
    severity: "warning",
    message: "m",
    source: "com.puppycrawl.tools.checkstyle.checks.naming.MemberNameCheck",
    ...over,
  });
  const range = (over: Partial<CheckstyleError>, lines: string[], tabWidth = 8) =>
    toDiagnostic(error(over), lines, tabWidth).range;

  test("the word at a column, where tabs count up to the next multiple", () => {
    // As measured: two tabs and "int  " put `bad_name` at column 22.
    expect(range({ line: 1, column: 22 }, ["\t\tint  bad_name=1;"])).toEqual({
      start: { line: 0, character: 7 },
      end: { line: 0, character: 15 },
    });
    expect(range({ line: 1, column: 5 }, ["\t\tint  bad_name=1;"], 2)).toEqual({
      start: { line: 0, character: 2 },
      end: { line: 0, character: 5 },
    });
  });

  test("one character where there's no word, and the last at or past the end", () => {
    expect(range({ line: 1, column: 3 }, ["a  = 1"]).end.character).toBe(3);
    expect(range({ line: 1, column: 4 }, ["a  = 1"])).toEqual({
      start: { line: 0, character: 3 },
      end: { line: 0, character: 4 },
    });
    expect(range({ line: 1, column: 50 }, ["abc"])).toEqual({
      start: { line: 0, character: 2 },
      end: { line: 0, character: 3 },
    });
  });

  test("a column past a character outside the basic plane", () => {
    expect(range({ line: 1, column: 3 }, ["\u{1F600}a bc"]).start.character).toBe(3);
  });

  test("no column: the line without its indent", () => {
    expect(range({ line: 2 }, ["x", "   long line  "])).toEqual({
      start: { line: 1, character: 3 },
      end: { line: 1, character: 12 },
    });
  });

  test("a line outside the file, or about the file itself", () => {
    expect(range({ line: 0 }, ["a"]).start.line).toBe(0);
    expect(range({ line: 9 }, ["a", "b"]).start.line).toBe(1);
    expect(range({ line: 1 }, []).start).toEqual({ line: 0, character: 0 });
  });

  test("severity, source, short name and its page", () => {
    expect(toDiagnostic(error({ severity: "error" }), ["a"], 8)).toMatchObject({
      severity: 1,
      source: "checkstyle",
      code: "MemberName",
      codeDescription: { href: "https://checkstyle.org/checks/naming/membername.html#MemberName" },
    });
    expect(toDiagnostic(error({ severity: "info" }), ["a"], 8).severity).toBe(3);
  });

  test("checks whose page is under misc", () => {
    const href = (source: string) =>
      toDiagnostic(error({ source }), ["a"], 8).codeDescription?.href;
    expect(href("com.puppycrawl.tools.checkstyle.checks.TodoCommentCheck")).toBe(
      "https://checkstyle.org/checks/misc/todocomment.html#TodoComment",
    );
    expect(href("com.puppycrawl.tools.checkstyle.checks.indentation.IndentationCheck")).toBe(
      "https://checkstyle.org/checks/misc/indentation.html#Indentation",
    );
  });

  test("a config's id or someone else's check has a code and no page", () => {
    for (const [source, code] of [
      ["myId", "myId"],
      ["com.example.FooCheck", "Foo"],
    ] as const) {
      const diagnostic = toDiagnostic(error({ source }), ["a"], 8);
      expect(diagnostic.code).toBe(code);
      expect(diagnostic.codeDescription).toBeUndefined();
    }
  });

  test("no source, no code", () => {
    expect(toDiagnostic(error({ source: "" }), ["a"], 8).code).toBeUndefined();
  });
});

describe("localConfig", () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function inDir(): Promise<void> {
    dir = await realpath(await mkdtemp(join(tmpdir(), "checkstyle-local-")));
    await writeFile(join(dir, "s.xml"), "<suppressions/>");
  }

  test("takes cacheFile out however it's written", async () => {
    await inDir();
    for (const property of [
      `<property name="cacheFile" value="x"/>`,
      `<property value="x>y" name='cacheFile' />`,
      `<property\n  name = "cacheFile"\n  value="\${c}"></property>`,
      `<property name="cacheFile" value="x"> </property>`,
    ]) {
      const text = `<module name="Checker">${property}<property name="cacheFileX" value="kept"/></module>`;
      const local = localConfig(text, [dir]);
      expect(local).not.toContain('"x"');
      expect(local).not.toMatch(/name\s*=\s*["']cacheFile["']/);
      expect(local).toContain("cacheFileX");
    }
  });

  test("makes a relative file absolute, where it exists", async () => {
    await inDir();
    const text = (value: string) =>
      `<module name="SuppressionFilter"><property name="file" value="${value}"/></module>`;
    expect(localConfig(text("s.xml"), ["/nowhere", dir])).toBe(text(join(dir, "s.xml")));
    for (const value of ["gone.xml", "/abs/s.xml", "${config_loc}/s.xml", "http://x/s.xml"]) {
      expect(localConfig(text(value), [dir])).toBe(text(value));
    }
  });

  test("leaves a config with nothing to change as it is", async () => {
    await inDir();
    const text = `<module name="Checker"><property name="severity" value="warning"/></module>`;
    expect(localConfig(text, [dir])).toBe(text);
  });
});

describe("namesUnproxiedUrl", () => {
  const property = (value: string) => `<property name="file" value="${value}"/>`;

  test("a value that is one, however spelled", () => {
    for (const value of [
      "ftp://192.0.2.1/s.xml",
      "FTP://192.0.2.1/s.xml",
      "jar:ftp://192.0.2.1/s.jar!/s.xml",
      "&#102;tp://192.0.2.1/s.xml",
      "mailto:a@example.com",
      "a.xml, ftp://192.0.2.1/b.xml",
      "${u}/s.xml",
    ]) {
      expect(namesUnproxiedUrl(property(value), { u: "ftp://192.0.2.1" })).toBe(true);
    }
    expect(namesUnproxiedUrl(`<property value='ftp://x' name='file'/>`, {})).toBe(true);
  });

  test("not a pattern that mentions one, or anything else", () => {
    for (const value of ["^.*(http|ftp)://.*$", "a|ftp://", "http://x/s.xml", "${u}", "file.xml"]) {
      expect(namesUnproxiedUrl(property(value), {})).toBe(false);
    }
  });
});

test("configTabWidth reads the config, a property it names, or the default", () => {
  const config = (value: string) => `<property name="tabWidth" value="${value}"/>`;
  expect(configTabWidth(config("4"), {})).toBe(4);
  expect(configTabWidth(config("${w}"), { w: "2" })).toBe(2);
  expect(configTabWidth(config("${w}"), {})).toBe(8);
  expect(configTabWidth(config("x"), {})).toBe(8);
  expect(configTabWidth("<module/>", {})).toBe(8);
});

test("propertiesFileText escapes what java.util.Properties would read otherwise", () => {
  expect(propertiesFileText({ "a.b": "/x y/c:d=e#f", cé: "é\n\\", z: "" })).toBe(
    "a.b=/x\\ y/c\\:d\\=e\\#f\nc\\u00e9=\\u00e9\\n\\\\\nz=\n",
  );
});
