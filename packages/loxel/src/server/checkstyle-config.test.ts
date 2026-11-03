import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  CheckstyleDiscovery,
  findCheckstyleProject,
  mayAffectCheckstyle,
  parsePropertiesText,
  withoutXmlComments,
} from "./checkstyle-config";

let wt: string;

afterEach(async () => {
  await rm(wt, { recursive: true, force: true });
});

async function setUp(files: Record<string, string>): Promise<void> {
  wt = await realpath(await mkdtemp(join(tmpdir(), "checkstyle-config-")));
  for (const [path, text] of Object.entries(files)) {
    const file = join(wt, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

const plugin = (configuration: string, extra = "") =>
  `<plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-checkstyle-plugin</artifactId>${extra}<configuration>${configuration}</configuration></plugin>`;
const pom = (body: string) =>
  `<project><modelVersion>4.0.0</modelVersion><artifactId>app</artifactId>${body}</project>`;
const build = (plugins: string) => `<build><plugins>${plugins}</plugins></build>`;

describe("Maven", () => {
  test("reads the config, its properties and the pinned version", async () => {
    await setUp({
      "pom.xml": pom(
        `<properties><checkstyle.configdir>src/conf</checkstyle.configdir><tool.version>12.3.1</tool.version></properties>` +
          build(
            plugin(
              `<configLocation>\${checkstyle.configdir}/checks.xml</configLocation><suppressionsLocation>src/conf/s.xml</suppressionsLocation><propertyExpansion>extra=\${basedir}/x
other=1</propertyExpansion><includeTestSourceDirectory>true</includeTestSourceDirectory><excludes>**/gen/**,**/Skip.java</excludes>`,
              `<dependencies><dependency><groupId>com.puppycrawl.tools</groupId><artifactId>checkstyle</artifactId><version>\${tool.version}</version></dependency></dependencies>`,
            ),
          ),
      ),
      "src/conf/checks.xml": "<module/>",
      "src/conf/s.xml": "<suppressions/>",
    });
    const project = findCheckstyleProject(join(wt, "src/main/java"), wt);
    expect(project?.config).toEqual({ kind: "file", path: join(wt, "src/conf/checks.xml") });
    expect(project?.pinnedVersion).toBe("12.3.1");
    expect(project?.properties).toMatchObject({
      basedir: wt,
      extra: `${wt}/x`,
      other: "1",
      "checkstyle.suppressions.file": join(wt, "src/conf/s.xml"),
    });
    const discovery = new CheckstyleDiscovery(wt);
    expect(discovery.projectFor(join(wt, "src/main/java/A.java"))).not.toBeNull();
    expect(discovery.projectFor(join(wt, "src/test/java/ATest.java"))).not.toBeNull();
    expect(discovery.projectFor(join(wt, "src/main/java/gen/G.java"))).toBeNull();
    expect(discovery.projectFor(join(wt, "src/main/java/a/Skip.java"))).toBeNull();
    expect(discovery.projectFor(join(wt, "src/it/java/B.java"))).toBeNull();
  });

  test("leaves tests out unless the plugin includes them, and checks a package named build", async () => {
    await setUp({ "pom.xml": pom(build(plugin(""))) });
    const discovery = new CheckstyleDiscovery(wt);
    expect(discovery.projectFor(join(wt, "src/test/java/ATest.java"))).toBeNull();
    expect(discovery.projectFor(join(wt, "target/generated/A.java"))).toBeNull();
    expect(discovery.projectFor(join(wt, "src/main/java/org/build/A.java"))).not.toBeNull();
  });

  test("the plugin's defaults: Sun's bundled config", async () => {
    await setUp({ "pom.xml": pom(build(plugin(""))) });
    expect(findCheckstyleProject(wt, wt)?.config).toEqual({
      kind: "bundled",
      name: "sun_checks.xml",
    });
  });

  test("a bundled config, and one it can't reach", async () => {
    await setUp({
      "pom.xml": pom(build(plugin("<configLocation>google_checks.xml</configLocation>"))),
      "b/pom.xml": pom(build(plugin("<configLocation>https://x.example/c.xml</configLocation>"))),
      "c/pom.xml": pom(build(plugin("<configLocation>from/a/dependency.xml</configLocation>"))),
    });
    expect(findCheckstyleProject(wt, wt)?.config).toEqual({
      kind: "bundled",
      name: "google_checks.xml",
    });
    for (const dir of ["b", "c"]) {
      expect(findCheckstyleProject(join(wt, dir), wt)?.config.kind).toBe("not-found");
    }
  });

  test("a module's parent applies it, and the parent's management configures it", async () => {
    await setUp({
      "pom.xml": pom(
        `<build><pluginManagement><plugins>${plugin("<configLocation>tools/c.xml</configLocation>")}</plugins></pluginManagement></build>`,
      ),
      "tools/c.xml": "<module/>",
      "mod/pom.xml": pom(
        `<parent><artifactId>app</artifactId></parent>${build(plugin(""))}`,
      ).replace("<artifactId>app</artifactId><parent>", "<artifactId>mod</artifactId><parent>"),
    });
    const project = findCheckstyleProject(join(wt, "mod/src/main/java"), wt);
    expect(project?.dir).toBe(join(wt, "mod"));
    expect(project?.config).toEqual({ kind: "file", path: join(wt, "tools/c.xml") });
  });

  test("a parent from a repository ends the chain at a pom above it", async () => {
    await setUp({
      "pom.xml": pom(build(plugin(""))),
      "mod/pom.xml": `<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent><artifactId>mod</artifactId></project>`,
      "lone/pom.xml": `<project><artifactId>lone</artifactId></project>`,
    });
    expect(findCheckstyleProject(join(wt, "mod"), wt)).toBeNull();
    expect(findCheckstyleProject(join(wt, "lone"), wt)).toBeNull();
  });

  test("a config in a sibling module's resources", async () => {
    await setUp({
      "pom.xml": pom(build(plugin("<configLocation>rules/c.xml</configLocation>"))),
      "tools/src/main/resources/rules/c.xml": "<module/>",
    });
    expect(findCheckstyleProject(wt, wt)?.config).toEqual({
      kind: "file",
      path: join(wt, "tools/src/main/resources/rules/c.xml"),
    });
  });

  test("a leading slash means the top of the build", async () => {
    await setUp({
      "pom.xml": pom(build(plugin("<configLocation>/tools/c.xml</configLocation>"))),
      "tools/c.xml": "<module/>",
    });
    expect(findCheckstyleProject(wt, wt)?.config.kind).toBe("file");
  });

  test("a pom that names itself or a child as its parent ends the chain", async () => {
    await setUp({
      "pom.xml": pom(`<parent><relativePath>.</relativePath></parent>${build(plugin(""))}`),
      "a/pom.xml": `<project><artifactId>a</artifactId><parent><artifactId>b</artifactId><relativePath>../b</relativePath></parent></project>`,
      "b/pom.xml": `<project><artifactId>b</artifactId><parent><artifactId>a</artifactId><relativePath>../a</relativePath></parent></project>`,
    });
    expect(findCheckstyleProject(wt, wt)?.dir).toBe(wt);
    expect(findCheckstyleProject(join(wt, "a"), wt)).toBeNull();
  });

  test("a location outside the worktree isn't read", async () => {
    await setUp({
      "pom.xml": pom(build(plugin("<configLocation>../outside.xml</configLocation>"))),
      "b/pom.xml": pom(build(plugin("<configLocation>link.xml</configLocation>"))),
    });
    const outside = join(dirname(wt), `${basename(wt)}-outside.xml`);
    await writeFile(outside, "<module/>");
    await symlink(outside, join(wt, "b/link.xml"));
    await writeFile(
      join(wt, "pom.xml"),
      pom(build(plugin(`<configLocation>../${basename(outside)}</configLocation>`))),
    );
    expect(findCheckstyleProject(wt, wt)?.config.kind).toBe("not-found");
    expect(findCheckstyleProject(join(wt, "b"), wt)?.config.kind).toBe("not-found");
    await rm(outside);
  });

  test("skip turns it off, unless only a profile says so", async () => {
    await setUp({
      "a/pom.xml": pom(build(plugin("<skip>true</skip>"))),
      "b/pom.xml": pom(
        `<properties><checkstyle.skip>true</checkstyle.skip></properties>${build(plugin(""))}`,
      ),
      "c/pom.xml": pom(
        `${build(plugin(""))}<profiles><profile><build><plugins>${plugin("<skip>true</skip>")}</plugins></build></profile></profiles>`,
      ),
    });
    expect(findCheckstyleProject(join(wt, "a"), wt)).toBeNull();
    expect(findCheckstyleProject(join(wt, "b"), wt)).toBeNull();
    expect(findCheckstyleProject(join(wt, "c"), wt)).not.toBeNull();
  });

  test("management with no config, a commented-out plugin, and a bare config file don't count", async () => {
    await setUp({
      "a/pom.xml": pom(
        `<build><pluginManagement><plugins>${plugin("")}</plugins></pluginManagement></build>`,
      ),
      "b/pom.xml": pom(`<!-- ${build(plugin(""))} -->`),
      "c/pom.xml": pom(""),
      "c/checkstyle.xml": "<module/>",
      "d/checkstyle.xml": "<module/>",
      "d/config/checkstyle/checkstyle.xml": "<module/>",
    });
    for (const dir of ["a", "b", "c", "d"]) {
      expect(findCheckstyleProject(join(wt, dir), wt)).toBeNull();
    }
  });
});

describe("Gradle", () => {
  const defaults = { "settings.gradle": "", "config/checkstyle/checkstyle.xml": "<module/>" };

  test("the plugin's defaults, with config_loc", async () => {
    await setUp({ ...defaults, "build.gradle": "plugins { id 'java'; id 'checkstyle' }\n" });
    const project = findCheckstyleProject(join(wt, "src/main/java"), wt);
    expect(project?.config).toEqual({
      kind: "file",
      path: join(wt, "config/checkstyle/checkstyle.xml"),
    });
    expect(project?.properties).toEqual({ basedir: wt, config_loc: join(wt, "config/checkstyle") });
    expect(project?.scope.includeTests).toBe(true);
  });

  test("a Kotlin script's bare plugin", async () => {
    await setUp({ ...defaults, "build.gradle.kts": "plugins {\n  java\n  checkstyle\n}\n" });
    expect(findCheckstyleProject(wt, wt)).not.toBeNull();
  });

  test("a config directory, version and properties from the build", async () => {
    await setUp({
      "settings.gradle": "",
      "gradle.properties": "csVersion=10.20\n",
      "buildscripts/checkstyle.xml": "<module/>",
      "build.gradle": `subprojects {
  apply plugin: "checkstyle"
  checkstyle {
    configDirectory = file("$rootDir/buildscripts")
    toolVersion = csVersion
    configProperties = ['a.b': "\${rootDir}/x", c: 'd', unknown: "$other/y"]
  }
}
`,
      "mod/build.gradle": "plugins { id 'java' }\n",
    });
    const project = findCheckstyleProject(join(wt, "mod/src/main/java"), wt);
    expect(project?.dir).toBe(join(wt, "mod"));
    expect(project?.rootDir).toBe(wt);
    expect(project?.buildFile).toBe(join(wt, "build.gradle"));
    expect(project?.config).toEqual({
      kind: "file",
      path: join(wt, "buildscripts/checkstyle.xml"),
    });
    expect(project?.pinnedVersion).toBe("10.20");
    expect(project?.properties).toEqual({
      basedir: join(wt, "mod"),
      config_loc: join(wt, "buildscripts"),
      "a.b": `${wt}/x`,
      c: "d",
    });
  });

  test("a root that applies it only to itself doesn't reach a subproject", async () => {
    await setUp({
      ...defaults,
      "build.gradle": "plugins { id 'checkstyle' }\n",
      "mod/build.gradle": "plugins { id 'java' }\n",
    });
    expect(findCheckstyleProject(join(wt, "mod"), wt)).toBeNull();
    expect(findCheckstyleProject(wt, wt)).not.toBeNull();
  });

  test("a convention plugin, whose own build file isn't what it applies", async () => {
    await setUp({
      "settings.gradle": "",
      "build.gradle": "plugins { id 'java' }\n",
      "src/rules/checkstyle.xml": "<module/>",
      "buildSrc/build.gradle":
        "plugins { id 'checkstyle' }\ncheckstyle { configDirectory = rootProject.file('other') }\n",
      "buildSrc/src/main/java/org/build/Conventions.java": `class Conventions { void a(Project project) {
        project.getPlugins().apply(CheckstylePlugin.class);
        checkstyle.setToolVersion("14.3.0");
        checkstyle.getConfigDirectory().set(project.getRootProject().file("src/rules"));
      } }`,
    });
    const project = findCheckstyleProject(wt, wt);
    expect(project?.config).toEqual({ kind: "file", path: join(wt, "src/rules/checkstyle.xml") });
    expect(project?.pinnedVersion).toBe("14.3.0");
  });

  test("a config named through resources.text, the main one of several", async () => {
    await setUp({
      "settings.gradle": "",
      "gradle/config/main.xml": "<module/>",
      "gradle/config/test.xml": "<module/>",
      "build.gradle.kts": `plugins { id("checkstyle") }
checkstyle { configDirectory = rootProject.layout.projectDirectory.dir("gradle/config") }
tasks.checkstyleTest { config = resources.text.fromFile(checkstyle.configDirectory.file("test.xml")) }
tasks.checkstyleMain { config = resources.text.fromFile(checkstyle.configDirectory.file("main.xml")) }
`,
    });
    expect(findCheckstyleProject(wt, wt)?.config).toEqual({
      kind: "file",
      path: join(wt, "gradle/config/main.xml"),
    });
  });

  test("the version catalog's version or library", async () => {
    await setUp({
      ...defaults,
      "build.gradle":
        "plugins { id 'checkstyle' }\ncheckstyle { toolVersion = libs.checkstyle.get().version }\n",
      "gradle/libs.versions.toml": `[libraries]\ncheckstyle = "com.puppycrawl.tools:checkstyle:13.0.0"\n`,
    });
    expect(findCheckstyleProject(wt, wt)?.pinnedVersion).toBe("13.0.0");
  });

  test("source sets, disabled tasks and excludes", async () => {
    await setUp({
      ...defaults,
      "a/build.gradle":
        "apply plugin: 'checkstyle'\ncheckstyle { sourceSets = [sourceSets.main] }\n",
      "b/build.gradle": "apply plugin: 'checkstyle'\ncheckstyleTest.enabled = false\n",
      "c/build.gradle": `apply plugin: 'checkstyle'
tasks.withType(Checkstyle) { exclude '**/generated/**' }
`,
      "d/build.gradle": "apply plugin: 'checkstyle'\n",
    });
    const discovery = new CheckstyleDiscovery(wt);
    for (const dir of ["a", "b"]) {
      expect(discovery.projectFor(join(wt, dir, "src/test/java/T.java"))).toBeNull();
      expect(discovery.projectFor(join(wt, dir, "src/main/java/T.java"))).not.toBeNull();
    }
    expect(discovery.projectFor(join(wt, "c/src/main/java/generated/G.java"))).toBeNull();
    expect(discovery.projectFor(join(wt, "c/src/main/java/G.java"))).not.toBeNull();
    expect(discovery.projectFor(join(wt, "d/src/test/java/T.java"))).not.toBeNull();
    expect(discovery.projectFor(join(wt, "d/build/generated/G.java"))).toBeNull();
  });

  test("other tools' settings aren't taken for Checkstyle's", async () => {
    await setUp({
      ...defaults,
      "codenarc.xml": "<module/>",
      "build.gradle": `plugins { id 'checkstyle'; id 'jacoco'; id 'codenarc' }
jacoco { toolVersion = "0.8.11" }
codenarc { configFile = file("codenarc.xml"); toolVersion = "3.0" }
`,
    });
    const project = findCheckstyleProject(wt, wt);
    expect(project?.pinnedVersion).toBeNull();
    expect(project?.config).toEqual({
      kind: "file",
      path: join(wt, "config/checkstyle/checkstyle.xml"),
    });
  });

  test("a build that doesn't use it, whatever files sit around", async () => {
    await setUp({ ...defaults, "build.gradle": "plugins { id 'java' } // id 'checkstyle'\n" });
    expect(findCheckstyleProject(wt, wt)).toBeNull();
  });

  test("a missing config says where it looked", async () => {
    await setUp({ "settings.gradle": "", "build.gradle": "plugins { id 'checkstyle' }\n" });
    expect(findCheckstyleProject(wt, wt)?.config).toEqual({
      kind: "not-found",
      location: "config/checkstyle/checkstyle.xml",
    });
  });
});

test("the nearest build decides, each subproject on its own", async () => {
  await setUp({
    "pom.xml": pom(build(plugin(""))),
    "services/a/build.gradle": "apply plugin: 'checkstyle'\n",
    "services/a/config/checkstyle/checkstyle.xml": "<module/>",
    "services/b/build.gradle": "plugins { id 'java' }\n",
  });
  expect(findCheckstyleProject(join(wt, "services/a"), wt)?.dir).toBe(join(wt, "services/a"));
  expect(findCheckstyleProject(join(wt, "services/b"), wt)).toBeNull();
  expect(findCheckstyleProject(wt, wt)?.dir).toBe(wt);
});

test("discovery remembers until cleared, which build file changes do", async () => {
  await setUp({ "pom.xml": pom("") });
  const discovery = new CheckstyleDiscovery(wt);
  const file = join(wt, "src/main/java/A.java");
  expect(discovery.projectFor(file)).toBeNull();
  await writeFile(join(wt, "pom.xml"), pom(build(plugin(""))));
  expect(discovery.projectFor(file)).toBeNull();
  discovery.clear();
  expect(discovery.projectFor(file)).not.toBeNull();
  expect(mayAffectCheckstyle(join(wt, "pom.xml"))).toBe(true);
  expect(mayAffectCheckstyle(join(wt, "gradle/libs.versions.toml"))).toBe(true);
  expect(mayAffectCheckstyle(join(wt, "buildSrc/src/Conv.java"))).toBe(true);
  expect(mayAffectCheckstyle(file)).toBe(false);
});

test("withoutXmlComments reads comments left to right, as a parser does", () => {
  expect(withoutXmlComments("a<!-- b -->c<!--d-->e")).toBe("ace");
  expect(withoutXmlComments("<!<!-- x -->-- y -->z")).toBe("<!-- y -->z");
  expect(withoutXmlComments("a<!-- open")).toBe("a");
  expect(withoutXmlComments("<!-- a --> -->")).toBe(" -->");
});

test("parsePropertiesText reads key=value lines", () => {
  expect(parsePropertiesText("# no\na=1\n  b : 2 \nc.d=\n!e=3")).toEqual({
    a: "1",
    b: "2",
    "c.d": "",
  });
});
