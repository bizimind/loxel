import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { findJavaFormatDeclaration } from "./java-format-declaration";

let wt: string | undefined;

const originalHome = process.env.HOME;

afterEach(async () => {
  process.env.HOME = originalHome;
  if (wt) await rm(wt, { recursive: true, force: true });
  wt = undefined;
});

async function declared(files: Record<string, string>, dir = "src", fileName?: string) {
  wt = await realpath(await mkdtemp(join(tmpdir(), "java-format-declaration-")));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(wt, name)), { recursive: true });
    await writeFile(join(wt, name), content);
  }
  return findJavaFormatDeclaration(join(wt, dir), wt, fileName);
}

const spotlessPom = (java: string, extra = "") => `<project>${extra}<build><plugins><plugin>
  <groupId>com.diffplug.spotless</groupId>
  <artifactId>spotless-maven-plugin</artifactId>
  <version>3.10.0</version>
  <configuration><java>${java}</java></configuration>
</plugin></plugins></build></project>`;

const fmtPom = (group: string, body: string) => `<project><build><plugins><plugin>
  <groupId>${group}</groupId>
  <artifactId>fmt-maven-plugin</artifactId>
  <version>2.29.0</version>
  ${body}
</plugin></plugins></build></project>`;

const REFLOW = "--skip-reflowing-long-strings";
const GJF = "<googleJavaFormat><version>1.22.0</version></googleJavaFormat>";

describe("no signal", () => {
  test.each([
    ["no build file", {}],
    ["a plain POM", { "pom.xml": "<project><artifactId>a</artifactId></project>" }],
    ["a plain Gradle build", { "build.gradle": "plugins { id 'java' }\n" }],
    ["Spotless with Eclipse", { "pom.xml": spotlessPom("<eclipse/>") }],
    ["Spotless with import steps only", { "pom.xml": spotlessPom("<removeUnusedImports/>") }],
    [
      "Gradle Spotless with import steps only",
      { "build.gradle": "spotless { java { removeUnusedImports(); licenseHeader('x') } }\n" },
    ],
    [
      "a library dependency, not a formatter step",
      {
        "build.gradle":
          "dependencies { implementation 'com.google.googlejavaformat:google-java-format:1.22.0' }\nprintln(libs.googleJavaFormat.get().version)\n",
      },
    ],
    ["a commented-out step", { "build.gradle": "// googleJavaFormat('1.22.0')\n" }],
    ["a commented-out POM", { "pom.xml": `<!-- ${spotlessPom(GJF)} -->` }],
    ["a fmt plugin of another group", { "pom.xml": fmtPom("org.example", "") }],
  ])("%s formats nothing", async (_name, files: Record<string, string>) => {
    expect(await declared(files)).toBeNull();
  });
});

describe("Spotless for Maven", () => {
  test("no version declines: Spotless picks one by its own release", async () => {
    const notice = expect.stringContaining("Spotless chooses this project's google-java-format");
    expect(await declared({ "pom.xml": spotlessPom("<googleJavaFormat/>") })).toEqual({ notice });
    await rm(wt ?? "", { recursive: true, force: true });
    expect(
      await declared({ "build.gradle": "spotless { java { googleJavaFormat() } }\n" }),
    ).toEqual({ notice });
  });

  test("reads the version and options", async () => {
    const java = `<googleJavaFormat>
      <version>1.22.0</version><style>AOSP</style><reflowLongStrings>true</reflowLongStrings>
      <formatJavadoc>false</formatJavadoc><reorderImports>true</reorderImports>
    </googleJavaFormat>`;
    expect(await declared({ "pom.xml": spotlessPom(java) })).toEqual({
      tool: "google-java-format",
      pin: "1.22.0",
      flags: ["--aosp", "--skip-javadoc-formatting"],
    });
  });

  test("AOSP without reorderImports keeps the imports as they are", async () => {
    const java =
      "<googleJavaFormat><version>1.22.0</version><style>AOSP</style></googleJavaFormat>";
    expect(await declared({ "pom.xml": spotlessPom(java) })).toMatchObject({
      flags: ["--aosp", "--skip-sorting-imports", REFLOW],
    });
  });

  test("a property may be in this POM or a parent's in the repository", async () => {
    const java =
      "<palantirJavaFormat><version>${palantirJavaFormat.version}</version></palantirJavaFormat>";
    expect(
      await declared(
        {
          "pom.xml":
            "<project><properties><palantirJavaFormat.version>2.103.0</palantirJavaFormat.version></properties></project>",
          "module/pom.xml": spotlessPom(java),
        },
        "module/src",
      ),
    ).toEqual({ tool: "palantir-java-format", pin: "2.103.0", flags: ["--palantir", REFLOW] });
  });

  test("a property it cannot find declines rather than guess", async () => {
    const java = "<googleJavaFormat><version>${gjf.version}</version></googleJavaFormat>";
    expect(await declared({ "pom.xml": spotlessPom(java) })).toEqual({
      notice: expect.stringContaining("can't determine which google-java-format version"),
    });
  });

  test("a value that is no version declines", async () => {
    const java = "<googleJavaFormat><version>../../evil</version></googleJavaFormat>";
    expect(await declared({ "pom.xml": spotlessPom(java) })).toEqual({
      notice: expect.stringContaining("can't determine"),
    });
  });

  test("palantir styles and Javadoc", async () => {
    const aosp =
      "<palantirJavaFormat><version>2.1.0</version><style>AOSP</style></palantirJavaFormat>";
    expect(await declared({ "pom.xml": spotlessPom(aosp) })).toMatchObject({
      flags: ["--aosp", REFLOW],
    });
    await rm(wt ?? "", { recursive: true, force: true });
    const google =
      "<palantirJavaFormat><version>2.1.0</version><style>GOOGLE</style></palantirJavaFormat>";
    expect(await declared({ "pom.xml": spotlessPom(google) })).toMatchObject({ flags: [REFLOW] });
    await rm(wt ?? "", { recursive: true, force: true });
    const javadoc =
      "<palantirJavaFormat><version>2.1.0</version><formatJavadoc>true</formatJavadoc></palantirJavaFormat>";
    expect(await declared({ "pom.xml": spotlessPom(javadoc) })).toEqual({
      notice: expect.stringContaining("Javadoc"),
    });
  });

  test("toggleOffOn and a forked artifact decline", async () => {
    expect(await declared({ "pom.xml": spotlessPom(`${GJF}<toggleOffOn/>`) })).toEqual({
      notice: expect.stringContaining("toggleOffOn"),
    });
    await rm(wt ?? "", { recursive: true, force: true });
    const fork = "<googleJavaFormat><groupArtifact>a:b</groupArtifact></googleJavaFormat>";
    expect(await declared({ "pom.xml": spotlessPom(fork) })).toEqual({
      notice: expect.stringContaining("artifact"),
    });
  });
});

describe("fmt-maven-plugin", () => {
  /** The plugin's published POM in the user's Maven cache, as a build leaves it. */
  async function cachePluginPom(group: string, version: string, dependencyVersion: string) {
    const home = join(wt ?? "", "..", `home-${crypto.randomUUID()}`);
    process.env.HOME = home;
    const name = `fmt-maven-plugin-${version}.pom`;
    const path = join(
      home,
      ".m2/repository",
      ...group.split("."),
      "fmt-maven-plugin",
      version,
      name,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `<project><properties><gjf>1.28.0</gjf></properties><dependencies><dependency>
        <groupId>com.google.googlejavaformat</groupId>
        <artifactId>google-java-format</artifactId>
        <version>${dependencyVersion}</version>
      </dependency></dependencies></project>`,
    );
    return home;
  }

  test.each(["com.spotify.fmt", "com.coveo"])("%s with options", async (group) => {
    const body = `<configuration><style>aosp</style><skipSortingImports>true</skipSortingImports></configuration>`;
    wt = await realpath(await mkdtemp(join(tmpdir(), "java-format-declaration-")));
    const home = await cachePluginPom(group, "2.29.0", "1.13.0");
    const pom = fmtPom(group, body);
    await writeFile(join(wt, "pom.xml"), pom);
    expect(findJavaFormatDeclaration(join(wt, "src"), wt)).toEqual({
      tool: "google-java-format",
      pin: "1.13.0",
      flags: ["--aosp", "--skip-sorting-imports", REFLOW],
    });
    await rm(home, { recursive: true, force: true });
  });

  test("the formatter's version may be a property of the plugin's POM", async () => {
    wt = await realpath(await mkdtemp(join(tmpdir(), "java-format-declaration-")));
    const home = await cachePluginPom("com.spotify.fmt", "2.29.0", "${gjf}");
    await writeFile(join(wt, "pom.xml"), fmtPom("com.spotify.fmt", ""));
    expect(findJavaFormatDeclaration(join(wt, "src"), wt)).toMatchObject({ pin: "1.28.0" });
    await rm(home, { recursive: true, force: true });
  });

  test("a plugin not in the cache leaves the version undetermined", async () => {
    process.env.HOME = "/nonexistent-loxel-home";
    expect(await declared({ "pom.xml": fmtPom("com.spotify.fmt", "") })).toEqual({
      notice: expect.stringContaining("can't determine which google-java-format version"),
    });
  });

  test("a dependency override pins the version, and strings can be set to reflow", async () => {
    const body = `<configuration><skipReflowingLongStrings>false</skipReflowingLongStrings></configuration>
      <dependencies><dependency>
        <groupId>com.google.googlejavaformat</groupId>
        <artifactId>google-java-format</artifactId>
        <version>1.30.0</version>
      </dependency></dependencies>`;
    expect(await declared({ "pom.xml": fmtPom("com.spotify.fmt", body) })).toEqual({
      tool: "google-java-format",
      pin: "1.30.0",
      flags: [],
    });
  });
});

describe("Spotless for Gradle", () => {
  test("chained options, in Kotlin", async () => {
    const script = `spotless {
      java {
        googleJavaFormat("1.22.0")
          .aosp()
          .reflowLongStrings()
          .skipJavadocFormatting()
      }
    }`;
    expect(await declared({ "build.gradle.kts": script })).toEqual({
      tool: "google-java-format",
      pin: "1.22.0",
      flags: ["--aosp", "--skip-sorting-imports", "--skip-javadoc-formatting"],
    });
  });

  test("Groovy's call without parentheses", async () => {
    expect(
      await declared({ "build.gradle": "spotless { java { googleJavaFormat '1.8' } }\n" }),
    ).toMatchObject({ pin: "1.8" });
  });

  test("a catalog library, in any of its forms", async () => {
    const script = "spotless { java { googleJavaFormat(libs.googleJavaFormat.get().version) } }\n";
    const forms = [
      'googleJavaFormat = "com.google.googlejavaformat:google-java-format:1.36.1"',
      'googleJavaFormat = { module = "com.google.googlejavaformat:google-java-format", version = "1.36.1" }',
      'googleJavaFormat = { module = "com.google.googlejavaformat:google-java-format", version.ref = "gjf" }',
    ];
    for (const form of forms) {
      const catalog = `[versions]\ngjf = "1.36.1"\n[libraries]\n${form}\n`;
      expect(
        await declared({ "build.gradle": script, "gradle/libs.versions.toml": catalog }),
      ).toMatchObject({ pin: "1.36.1" });
      await rm(wt ?? "", { recursive: true, force: true });
    }
  });

  test("a catalog version with a dashed alias, from a nested module", async () => {
    expect(
      await declared(
        {
          "gradle/libs.versions.toml": '[versions]\ngoogle-java-format = "1.37.0"\n',
          "lib/build.gradle.kts":
            "spotless { java { googleJavaFormat(libs.versions.google.java.format.get()) } }\n",
        },
        "lib/src/main/java",
      ),
    ).toMatchObject({ pin: "1.37.0" });
  });

  test("a variable from the script or gradle.properties", async () => {
    expect(
      await declared({
        "build.gradle": "def gjf = '1.22.0'\nspotless { java { googleJavaFormat(gjf) } }\n",
      }),
    ).toMatchObject({ pin: "1.22.0" });
    await rm(wt ?? "", { recursive: true, force: true });
    expect(
      await declared({
        "build.gradle": 'spotless { java { googleJavaFormat("$gjfVersion") } }\n',
        "gradle.properties": "gjfVersion=1.23.0\n",
      }),
    ).toMatchObject({ pin: "1.23.0" });
  });

  test("an expression it cannot follow declines", async () => {
    expect(
      await declared({ "build.gradle": "spotless { java { googleJavaFormat(pickVersion()) } }\n" }),
    ).toEqual({ notice: expect.stringContaining("can't determine") });
  });

  test("palantir with a style and toggleOffOn", async () => {
    expect(
      await declared({
        "build.gradle": "spotless { java { palantirJavaFormat('2.50.0').style('AOSP') } }\n",
      }),
    ).toEqual({ tool: "palantir-java-format", pin: "2.50.0", flags: ["--aosp", REFLOW] });
    await rm(wt ?? "", { recursive: true, force: true });
    expect(
      await declared({
        "build.gradle": "spotless { java { toggleOffOn(); palantirJavaFormat() } }\n",
      }),
    ).toEqual({ notice: expect.stringContaining("toggleOffOn") });
  });
});

describe("Palantir's Gradle plugin", () => {
  test.each([
    [
      "plugins block",
      { "build.gradle": "plugins { id 'com.palantir.java-format' version '2.1.0' }\n" },
    ],
    [
      "Kotlin plugins block",
      { "build.gradle.kts": 'plugins { id("com.palantir.java-format") version "2.1.0" }\n' },
    ],
    [
      "buildscript classpath",
      {
        "build.gradle":
          "buildscript { dependencies { classpath 'com.palantir.javaformat:gradle-palantir-java-format:2.1.0' } }\n",
      },
    ],
    [
      "catalog plugin",
      {
        "build.gradle": "apply plugin: 'com.palantir.java-format'\n",
        "gradle/libs.versions.toml":
          '[plugins]\npjf = { id = "com.palantir.java-format", version = "2.1.0" }\n',
      },
    ],
  ])("%s", async (_name, files: Record<string, string>) => {
    expect(await declared(files)).toEqual({
      tool: "palantir-java-format",
      pin: "2.1.0",
      flags: ["--palantir", REFLOW],
    });
  });

  test("applied in a module, pinned at the root", async () => {
    expect(
      await declared(
        {
          "build.gradle":
            "buildscript { dependencies { classpath 'com.palantir.javaformat:gradle-palantir-java-format:2.1.0' } }\n",
          "lib/build.gradle": "apply plugin: 'com.palantir.java-format'\n",
        },
        "lib/src",
      ),
    ).toMatchObject({ pin: "2.1.0" });
  });

  test("a plugin with no visible version declines", async () => {
    expect(
      await declared({ "build.gradle": "apply plugin: 'com.palantir.java-format'\n" }),
    ).toEqual({ notice: expect.stringContaining("can't determine") });
  });
});

describe("applied or only available", () => {
  const managed = (
    java: string,
    plugins = "",
  ) => `<project><build><pluginManagement><plugins><plugin>
    <artifactId>spotless-maven-plugin</artifactId>
    <configuration><java>${java}</java></configuration>
  </plugin></plugins></pluginManagement><plugins>${plugins}</plugins></build></project>`;
  const BARE = "<plugin><artifactId>spotless-maven-plugin</artifactId></plugin>";

  test("pluginManagement alone formats no module", async () => {
    expect(
      await declared(
        { "pom.xml": managed(GJF), "a/pom.xml": "<project><artifactId>a</artifactId></project>" },
        "a/src",
      ),
    ).toBeNull();
  });

  test("a module applying it takes the configuration from above", async () => {
    expect(
      await declared(
        {
          "pom.xml": managed("<googleJavaFormat><version>1.22.0</version></googleJavaFormat>"),
          "a/pom.xml": `<project><build><plugins>${BARE}</plugins></build></project>`,
        },
        "a/src",
      ),
    ).toMatchObject({ pin: "1.22.0" });
  });

  test("applied in the same POM as its pluginManagement", async () => {
    const pom = managed("<googleJavaFormat><version>1.22.0</version></googleJavaFormat>", BARE);
    expect(await declared({ "pom.xml": pom })).toMatchObject({ pin: "1.22.0" });
  });

  test("the applied block's version wins over pluginManagement's", async () => {
    const applied = spotlessPom("<googleJavaFormat><version>1.23.0</version></googleJavaFormat>")
      .replace("<project>", "")
      .replace("</project>", "");
    const pom = `<project>${managed(
      "<googleJavaFormat><version>1.20.0</version></googleJavaFormat>",
    )
      .replace("<project>", "")
      .replace("</project>", "")}${applied}</project>`;
    expect(await declared({ "pom.xml": pom })).toMatchObject({ pin: "1.23.0" });
  });

  test("Gradle's apply false is no signal, until a module applies it", async () => {
    const root = "plugins { id 'com.palantir.java-format' version '2.1.0' apply false }\n";
    expect(await declared({ "build.gradle": root })).toBeNull();
    await rm(wt ?? "", { recursive: true, force: true });
    expect(
      await declared(
        { "build.gradle": root, "a/build.gradle": "apply plugin: 'com.palantir.java-format'\n" },
        "a/src",
      ),
    ).toMatchObject({ tool: "palantir-java-format", pin: "2.1.0" });
  });

  test("the plugin through a catalog alias", async () => {
    const catalog =
      '[plugins]\npjf = { id = "com.palantir.java-format", version = "2.1.0" }\nother = "a.b:1.0"\n';
    expect(
      await declared({
        "build.gradle.kts": "plugins { alias(libs.plugins.pjf) }\n",
        "gradle/libs.versions.toml": catalog,
      }),
    ).toMatchObject({ tool: "palantir-java-format", pin: "2.1.0" });
    await rm(wt ?? "", { recursive: true, force: true });
    expect(
      await declared({
        "build.gradle.kts": "plugins { alias(libs.plugins.other) }\n",
        "gradle/libs.versions.toml": catalog,
      }),
    ).toBeNull();
  });
});

describe("steps and options around the formatter", () => {
  test("an importOrder step keeps the imports for it to order", async () => {
    expect(
      await declared({
        "build.gradle":
          "spotless { java { googleJavaFormat('1.22.0'); importOrder('java', '') } }\n",
      }),
    ).toMatchObject({ flags: ["--skip-sorting-imports", REFLOW] });
    await rm(wt ?? "", { recursive: true, force: true });
    expect(
      await declared({
        "pom.xml": spotlessPom(
          "<palantirJavaFormat><version>2.1.0</version></palantirJavaFormat><importOrder/>",
        ),
      }),
    ).toMatchObject({ flags: ["--palantir", "--skip-sorting-imports", REFLOW] });
  });

  test("toggleOffOn only for another language leaves Java formatted", async () => {
    expect(
      await declared({
        "build.gradle":
          "spotless { java { googleJavaFormat('1.22.0') }\n kotlin { ktfmt(); toggleOffOn() } }\n",
      }),
    ).toMatchObject({ tool: "google-java-format" });
  });

  test("an option it cannot read declines", async () => {
    const maven = "<googleJavaFormat><style>${gjf.style}</style></googleJavaFormat>";
    expect(await declared({ "pom.xml": spotlessPom(maven) })).toEqual({
      notice: expect.stringContaining("options"),
    });
    await rm(wt ?? "", { recursive: true, force: true });
    expect(
      await declared({
        "build.gradle": "spotless { java { googleJavaFormat().style(gjfStyle) } }\n",
      }),
    ).toEqual({ notice: expect.stringContaining("options") });
    await rm(wt ?? "", { recursive: true, force: true });
    expect(
      await declared({
        "build.gradle": "spotless { java { googleJavaFormat().reorderImports(flag) } }\n",
      }),
    ).toEqual({ notice: expect.stringContaining("options") });
  });

  test("a task of the same name is no formatter", async () => {
    expect(
      await declared({ "build.gradle": "task googleJavaFormat(type: JavaExec) {}\n" }),
    ).toBeNull();
  });

  test("Spotless with Eclipse through configure ends the walk too", async () => {
    expect(
      await declared(
        {
          "pom.xml": spotlessPom(GJF),
          "a/build.gradle.kts": "configure<SpotlessExtension> { java { eclipse() } }\n",
        },
        "a/src",
      ),
    ).toBeNull();
  });

  test("unclosed tags in a large POM end the scan", async () => {
    const pom = `-maven-plugin${"<!-- <plugin><java>".repeat(50_000)}`;
    expect(await declared({ "pom.xml": pom })).toBeNull();
    await rm(wt ?? "", { recursive: true, force: true });
    const plugins = `-maven-plugin${"<plugin><java>".repeat(70_000)}`;
    expect(await declared({ "pom.xml": plugins })).toBeNull();
  });
});

describe("the nearest declaration decides", () => {
  test("a nested module's own formatter wins over the root's", async () => {
    expect(
      await declared(
        {
          "pom.xml": spotlessPom(GJF),
          "a/build.gradle": "spotless { java { palantirJavaFormat('2.1.0') } }\n",
        },
        "a/src",
      ),
    ).toMatchObject({ tool: "palantir-java-format" });
  });

  test("a module with no opinion inherits the root's", async () => {
    expect(
      await declared(
        {
          "pom.xml": spotlessPom(GJF),
          "a/pom.xml": "<project><artifactId>a</artifactId></project>",
        },
        "a/src",
      ),
    ).toMatchObject({ tool: "google-java-format" });
  });

  test("a module formatting with Eclipse does not inherit it", async () => {
    expect(
      await declared(
        { "pom.xml": spotlessPom(GJF), "a/build.gradle": "spotless { java { eclipse() } }\n" },
        "a/src",
      ),
    ).toBeNull();
  });

  test("an edited build file is read again", async () => {
    const first = await declared({ "pom.xml": spotlessPom(GJF) });
    expect(first).toMatchObject({ pin: "1.22.0" });
    const pom = join(wt ?? "", "pom.xml");
    await writeFile(
      pom,
      spotlessPom("<googleJavaFormat><version>1.23.0</version></googleJavaFormat>"),
    );
    expect(findJavaFormatDeclaration(join(wt ?? "", "src"), wt ?? "")).toMatchObject({
      pin: "1.23.0",
    });
  });
});

describe("which files a declaration formats", () => {
  const gradle = (java: string) => `spotless { java { googleJavaFormat('1.22.0')\n${java} } }\n`;
  const inScope = async (files: Record<string, string>, path: string) => {
    const slash = path.lastIndexOf("/");
    return (await declared(files, path.slice(0, slash), path.slice(slash + 1))) !== null;
  };
  const clean = () => rm(wt ?? "", { recursive: true, force: true });

  test("Maven's default is the standard source folders", async () => {
    const files = { "pom.xml": spotlessPom(GJF) };
    expect(await inScope(files, "src/main/java/a/A.java")).toBe(true);
    await clean();
    expect(await inScope(files, "src/test/java/A.java")).toBe(true);
    await clean();
    expect(await inScope(files, "target/generated-sources/A.java")).toBe(false);
    await clean();
    expect(await inScope(files, "testdata/A.java")).toBe(false);
  });

  test("Maven's includes and excludes, in a module of the declaring POM", async () => {
    const java = `${GJF}<includes><include>src/**/*.java</include></includes>
      <excludes><exclude>**/generated/**</exclude></excludes>`;
    const files = {
      "pom.xml": spotlessPom(java),
      "m/pom.xml": "<project><artifactId>m</artifactId></project>",
    };
    expect(await inScope(files, "m/src/custom/A.java")).toBe(true);
    await clean();
    expect(await inScope(files, "m/src/generated/A.java")).toBe(false);
    await clean();
    expect(await inScope(files, "m/other/A.java")).toBe(false);
  });

  test("Maven's globs with a variable format nothing, silently", async () => {
    const java = `${GJF}<includes><include>\${dir}/**/*.java</include></includes>`;
    expect(await inScope({ "pom.xml": spotlessPom(java) }, "src/main/java/A.java")).toBe(false);
    await clean();
    expect(
      await inScope(
        { "pom.xml": spotlessPom(GJF).replace("<java>", "<skip>true</skip><java>") },
        "src/main/java/A.java",
      ),
    ).toBe(false);
  });

  test("Gradle with no target covers any file, but its build directory", async () => {
    const files = { "build.gradle": gradle("") };
    expect(await inScope(files, "anywhere/A.java")).toBe(true);
    await clean();
    expect(await inScope(files, "build/generated/A.java")).toBe(false);
    await clean();
    expect(await inScope(files, "src/main/java/com/build/A.java")).toBe(true);
  });

  test.each([
    ["call", "target('src/**/*.java')\ntargetExclude('**/generated/**', 'src/skip/**')"],
    ["Groovy command", "target 'src/**/*.java'\ntargetExclude '**/generated/**', 'src/skip/**'"],
  ])("Gradle's target and targetExclude, as a %s", async (_form, java) => {
    const files = { "build.gradle": gradle(java) };
    expect(await inScope(files, "src/main/java/A.java")).toBe(true);
    await clean();
    expect(await inScope(files, "src/main/java/generated/A.java")).toBe(false);
    await clean();
    expect(await inScope(files, "src/skip/A.java")).toBe(false);
    await clean();
    expect(await inScope(files, "lib/A.java")).toBe(false);
  });

  test("a target from subprojects is relative to each subproject", async () => {
    const script = `subprojects {\n${gradle("target 'src/**/*.java'")}}\n`;
    const files = { "build.gradle": script, "lib/build.gradle": "" };
    expect(await inScope(files, "lib/src/main/java/A.java")).toBe(true);
    await clean();
    expect(await inScope(files, "lib/testdata/A.java")).toBe(false);
  });

  test("a project's own target is not relative to a module below it", async () => {
    const files = { "build.gradle": gradle("target 'src/**/*.java'"), "lib/build.gradle": "" };
    expect(await inScope(files, "lib/src/main/java/A.java")).toBe(false);
  });

  test.each([
    ["a variable", "target javaGlobs"],
    ["a fileTree", "target fileTree('src')"],
    ["an interpolated glob", 'target "$dir/**/*.java"'],
    ["an assignment", "target = 'src/**/*.java'"],
    ["a path out of the project", "target '../other/**/*.java'"],
    ["two calls", "target 'a/**'\ntarget 'b/**'"],
    ["a variable exclude", "targetExclude generated"],
    ["a content rule", "targetExcludeIfContentContains('@Generated')"],
  ])("%s formats nothing, silently", async (_form, java) => {
    expect(await inScope({ "build.gradle": gradle(java) }, "src/main/java/A.java")).toBe(false);
  });

  test("another language's target says nothing about Java's", async () => {
    const script = `spotless {\n java { googleJavaFormat('1.22.0') }\n kotlin { target 'x/**' }\n}\n`;
    expect(await inScope({ "build.gradle": script }, "src/main/java/A.java")).toBe(true);
  });

  test("Settings, which names no file, still lists the formatter", async () => {
    const script = gradle("target javaGlobs");
    expect(await declared({ "build.gradle": script })).toMatchObject({ pin: "1.22.0" });
  });

  test("the fmt plugin's settings that move its files format nothing", async () => {
    const pom = fmtPom(
      "com.spotify.fmt",
      `<configuration><sourceDirectory>gen</sourceDirectory></configuration>
       <dependencies><dependency><artifactId>google-java-format</artifactId><version>1.30.0</version></dependency></dependencies>`,
    );
    expect(await inScope({ "pom.xml": pom }, "src/main/java/A.java")).toBe(false);
  });
});
