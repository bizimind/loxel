import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CheckstyleError,
  failureMessage,
  parseCheckstyleXml,
  prepareConfig,
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

describe("prepareConfig", () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function inDir(files: Record<string, string> = {}): Promise<void> {
    dir = await realpath(await mkdtemp(join(tmpdir(), "checkstyle-local-")));
    await writeFile(join(dir, "s.xml"), "<suppressions/>");
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  }
  const textOf = (result: ReturnType<typeof prepareConfig>): string => {
    if ("refused" in result) throw new Error(result.refused);
    return result.text;
  };
  const filter = (attributes: string) =>
    `<module name="SuppressionFilter"><property ${attributes}/></module>`;

  test("takes cacheFile out however it's written", async () => {
    await inDir();
    for (const property of [
      `<property name="cacheFile" value="x"/>`,
      `<property value="x>y" name='cacheFile' />`,
      `<property\n  name = "cacheFile"\n  value="\${c}"></property>`,
      `<property name="cacheFile" value="x"> </property>`,
      `<property name=" cacheFile " value="x"/>`,
      `<property value="a>b" name="cache&#70;ile"/>`,
    ]) {
      const text = `<module name="Checker">${property}<property name="cacheFileX" value="kept"/></module>`;
      expect(textOf(prepareConfig(text, {}, [dir]))).toBe(
        '<module name="Checker"><property name="cacheFileX" value="kept"/></module>',
      );
    }
  });

  test("comments go, and one left open is refused", async () => {
    await inDir();
    const text = `<module><!-- <property name="cacheFile" value="x"/> --></module>`;
    expect(textOf(prepareConfig(text, {}, [dir]))).toBe("<module></module>");
    // A parser reads past the `<!--` in a processing instruction, so this must not run.
    const hidden = `<module><?x <!-- ?><property name="file" value="ftp://192.0.2.1/h"/></module>`;
    expect(prepareConfig(hidden, {}, [dir])).toEqual({
      refused: "it has a comment that isn't closed.",
    });
  });

  test("makes a relative file absolute, where it exists", async () => {
    await inDir();
    const result = prepareConfig(filter('name="file" value="s.xml"'), {}, ["/nowhere", dir]);
    expect(textOf(result)).toBe(filter(`name="file" value="${join(dir, "s.xml")}"`));
    expect(
      textOf(prepareConfig(`<property value="s.xml" name='headerFile' default="d"/>`, {}, [dir])),
    ).toContain(join(dir, "s.xml"));
    for (const value of ["gone.xml", "/abs/s.xml", "${config_loc}/s.xml", "http://x/s.xml"]) {
      const text = filter(`name="file" value="${value}"`);
      expect(textOf(prepareConfig(text, {}, [dir]))).toBe(text);
    }
  });

  test("makes a relative default absolute too, and each of headerFiles", async () => {
    await inDir({ "h1.txt": "a", "h2.txt": "b" });
    const s = join(dir, "s.xml");
    expect(
      textOf(
        prepareConfig(filter('name="file" value="${x}" default="s.xml" optional="true"'), {}, [
          dir,
        ]),
      ),
    ).toBe(filter(`name="file" value="\${x}" default="${s}" optional="true"`));
    expect(
      textOf(
        prepareConfig(filter('name="headerFiles" value="h1.txt, h2.txt,gone.txt"'), {}, [dir]),
      ),
    ).toBe(
      filter(`name="headerFiles" value="${join(dir, "h1.txt")},${join(dir, "h2.txt")},gone.txt"`),
    );
  });

  test("leaves a config with nothing to change as it is", async () => {
    await inDir();
    const text = `<module name="Checker"><property name="severity" value="warning"/></module>`;
    expect(prepareConfig(text, {}, [dir])).toEqual({ text, tabWidth: 8 });
  });

  test("refuses a URL the proxies don't reach, however spelled", async () => {
    await inDir();
    for (const attributes of [
      'name="file" value="ftp://192.0.2.1/s.xml"',
      'name="file" value="FTP://192.0.2.1/s.xml"',
      'name="file" value="jar:ftp://192.0.2.1/s.jar!/s.xml"',
      'name="file" value="url:ftp://192.0.2.1/s.xml"',
      'name="file" value="&#102;tp://192.0.2.1/s.xml"',
      'name="file" value="&#1;ftp://192.0.2.1/s.xml"',
      'name="file" value="mailto:a@example.com"',
      'name="headerFiles" value="a.xml, ftp://192.0.2.1/b.xml"',
      'name="file" value="${u}/s.xml"',
      'name="file" value="${nope}" default="ftp://192.0.2.1/s.xml"',
      'default="a>b" value=\'ftp://192.0.2.1/s.xml\' name="file"',
    ]) {
      expect(prepareConfig(filter(attributes), { u: "ftp://192.0.2.1" }, [dir])).toEqual({
        refused: "it names an FTP or mail URL, which Loxel doesn't fetch.",
      });
    }
  });

  test("not a pattern that mentions one, or anything else", async () => {
    await inDir();
    for (const value of ["^.*(http|ftp)://.*$", "a|ftp://", "http://x/s.xml", "${u}", "file.xml"]) {
      expect(
        "text" in prepareConfig(filter(`name="ignorePattern" value="${value}"`), {}, [dir]),
      ).toBe(true);
    }
  });

  const CONFIG_DOCTYPE =
    '<!DOCTYPE module PUBLIC "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN" "https://checkstyle.org/dtds/configuration_1_3.dtd">';

  test("takes only Checkstyle's own DOCTYPEs, or none", async () => {
    await inDir();
    const body = "<module/>";
    for (const head of [
      "",
      CONFIG_DOCTYPE,
      '<?xml version="1.0" encoding="UTF-8"?>\n' + CONFIG_DOCTYPE,
      "\uFEFF<?xml version='1.0'?>",
      '<!DOCTYPE module PUBLIC "-//Puppy Crawl//DTD Check Configuration 1.3//EN" "http://www.puppycrawl.com/dtds/configuration_1_3.dtd">',
      '<!DOCTYPE suppressions PUBLIC\n  "-//Checkstyle//DTD SuppressionFilter Configuration 1.2//EN"\n  "https://checkstyle.org/dtds/suppressions_1_2.dtd">',
    ]) {
      expect(prepareConfig(head + body, {}, [dir])).toMatchObject({ tabWidth: 8 });
    }
  });

  test("refuses any other DOCTYPE, processing instruction or CDATA, however placed", async () => {
    await inDir();
    const body = "<module/>";
    for (const text of [
      `<!DOCTYPE module [<!ENTITY a "cacheFile">]>${body}`,
      `${CONFIG_DOCTYPE.slice(0, -1)} [<!ATTLIST property name NMTOKEN "cacheFile">]>${body}`,
      `<!DOCTYPE module PUBLIC "-//X//DTD Y//EN" "https://x.example/x.dtd">${body}`,
      // An id Checkstyle doesn't know, so it would read the DTD at the system id.
      `<!DOCTYPE module PUBLIC "-//Checkstyle//DTD Checkstyle Configuration 1.4//EN" "http://127.0.0.1:8095/c.dtd">${body}`,
      `<!DOCTYPE module PUBLIC "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN" "ftp://192.0.2.1/x.dtd">${body}`,
      `<!DOCTYPE module PUBLIC "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN" "local.dtd">${body}`,
      `<!DOCTYPE module SYSTEM "https://checkstyle.org/dtds/configuration_1_3.dtd">${body}`,
      // A processing instruction shadowing the DOCTYPE that counts.
      `<?p <!DOCTYPE x> ?><!DOCTYPE module SYSTEM "ftp://192.0.2.1/x.dtd">${body}`,
      `<?p <!DOCTYPE x> ?>${CONFIG_DOCTYPE}${body}`,
      `${CONFIG_DOCTYPE}<!DOCTYPE module SYSTEM "ftp://192.0.2.1/x.dtd">${body}`,
      `${CONFIG_DOCTYPE}<module><?p x?></module>`,
      `<module><![CDATA[ <property name="cacheFile" value="x"/> ]]></module>`,
      `<module><!-- a --><?p <!-- b --> ?></module>`,
    ]) {
      expect("refused" in prepareConfig(text, {}, [dir])).toBe(true);
    }
  });

  test("the same for a suppressions file it names, which runs as it is", async () => {
    await inDir({
      "ftp.xml": `<!DOCTYPE suppressions SYSTEM "ftp://192.0.2.1/x.dtd"><suppressions/>`,
      "shadow.xml": `<?pi <!DOCTYPE d> ?><!DOCTYPE suppressions SYSTEM "ftp://192.0.2.1/x.dtd"><suppressions/>`,
      "open.xml": `<?pi <!-- ?><suppressions/>`,
      "fine.xml": `<?xml version="1.0"?>\n<!DOCTYPE suppressions PUBLIC "-//Checkstyle//DTD SuppressionFilter Configuration 1.2//EN" "https://checkstyle.org/dtds/suppressions_1_2.dtd"><suppressions/>`,
      "header.txt": "/* Licensed <here> */",
    });
    for (const name of ["ftp.xml", "shadow.xml", "open.xml"]) {
      expect("refused" in prepareConfig(filter(`name="file" value="${name}"`), {}, [dir])).toBe(
        true,
      );
      expect(
        "refused" in
          prepareConfig(filter(`name="file" value="\${s}"`), { s: join(dir, name) }, [dir]),
      ).toBe(true);
    }
    expect("text" in prepareConfig(filter('name="file" value="fine.xml"'), {}, [dir])).toBe(true);
    // Checkstyle takes `default` when the property `value` names isn't set.
    for (const name of ["ftp.xml", "shadow.xml"]) {
      const attributes = `name="file" value="\${unset}" default="${join(dir, name)}"`;
      expect("refused" in prepareConfig(filter(attributes), {}, [dir])).toBe(true);
    }
    expect("text" in prepareConfig(filter('name="headerFile" value="header.txt"'), {}, [dir])).toBe(
      true,
    );
  });

  test("the tab width it sets, however written, outside comments", async () => {
    await inDir();
    const width = (text: string, properties: Record<string, string> = {}) =>
      (prepareConfig(text, properties, [dir]) as { tabWidth: number }).tabWidth;
    const tab = (value: string) => `<property name="tabWidth" value="${value}"/>`;
    expect(width(tab("4"))).toBe(4);
    expect(width(`<property value="4" name='tabWidth'/>`)).toBe(4);
    expect(width(tab("${w}"), { w: "2" })).toBe(2);
    expect(width(tab("${w}"))).toBe(8);
    expect(width(tab("x"))).toBe(8);
    expect(width(`<!-- ${tab("2")} -->`)).toBe(8);
    expect(width(`<!-- ${tab("2")} -->${tab("4")}`)).toBe(4);
    expect(width("<module/>")).toBe(8);
  });

  test("refuses a property it can't read", async () => {
    await inDir();
    expect(prepareConfig(`<property name="cacheFile" value=unquoted/>`, {}, [dir])).toEqual({
      refused: "it has a property Loxel can't read.",
    });
  });
});

test("propertiesFileText escapes what java.util.Properties would read otherwise", () => {
  expect(propertiesFileText({ "a.b": "/x y/c:d=e#f", cé: "é\n\\", z: "" })).toBe(
    "a.b=/x\\ y/c\\:d\\=e\\#f\nc\\u00e9=\\u00e9\\n\\\\\nz=\n",
  );
});
