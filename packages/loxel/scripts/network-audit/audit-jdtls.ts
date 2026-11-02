/**
 * Proves at the socket level that the bundled Eclipse JDT LS makes no network requests when it runs
 * behind the real `loxel-server`, through opening files, every command a user can start and reading
 * JDK and dependency sources, and that with project import off it runs nothing from the project and leaves the project's files alone.
 * macOS only. Run it after changing the server's pin, its runtime or its manager; it exits non-zero
 * on any outbound attempt.
 *
 *   pnpm -C packages/loxel run build:server:standalone
 *   JAVA_HOME=<a JDK 25+ whose java allows DYLD, as Temurin's does> \\
 *     bun scripts/network-audit/audit-jdtls.ts [--control]
 *
 * `--control` runs the server without the JVM flag that keeps host names from resolving. It is the
 * positive control and must fail, by attempting to reach the hosts jdtls contacts by default.
 *
 * `--trusted` audits the same server in a trusted repository, where projects load and their code
 * runs, Gradle's daemons included. `--gradle-home <dir>` (a scratch copy: it gets written to) and
 * `--gradle-url <url>` name a Gradle user home and a distribution URL its wrapper has installed;
 * `--m2 <dir>` names a Maven repository with what a plain build needs. Without them only the projects
 * that need nothing from those run. With `--trusted --control` it must fail on a host name looked
 * up from a daemon, which proves the logger reaches daemons and that the options do the blocking.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

const LOXEL = path.resolve(import.meta.dir, "../..");
const BUILD = path.join(LOXEL, "build");
const REQUEST_TIMEOUT_MS = 180_000;

const { values } = parseArgs({
  options: {
    control: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    trusted: { type: "boolean", default: false },
    "gradle-home": { type: "string" },
    "gradle-url": { type: "string" },
    m2: { type: "string" },
  },
});

interface RpcMessage {
  id?: number;
  method?: string;
  params?: { uri?: string; diagnostics?: Diagnostic[]; type?: string; items?: unknown[] };
  result?: unknown;
  error?: unknown;
}

interface Position {
  line: number;
  character: number;
}

interface Range {
  start: Position;
  end: Position;
}

interface Diagnostic {
  message: string;
  range: Range;
}

interface TextEdit {
  range: Range;
  newText: string;
}

interface Command {
  command: string;
  arguments?: unknown[];
}

interface CodeAction {
  title: string;
  kind?: string;
  data?: unknown;
  command?: Command;
  edit?: {
    documentChanges?: { textDocument?: { uri: string }; edits?: TextEdit[] }[];
    changes?: Record<string, TextEdit[]>;
  };
}

interface CompletionItem {
  label: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: { newText: string };
  additionalTextEdits?: TextEdit[];
  command?: Command;
}

/** What Monaco's client advertises for the features exercised here. */
const CLIENT_CAPABILITIES = {
  workspace: {
    applyEdit: true,
    workspaceEdit: {
      documentChanges: true,
      resourceOperations: ["create", "rename", "delete"],
      failureHandling: "abort",
    },
    fileOperations: { dynamicRegistration: true, willRename: true },
    executeCommand: { dynamicRegistration: true },
    symbol: { dynamicRegistration: true },
  },
  textDocument: {
    synchronization: { dynamicRegistration: true },
    hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
    completion: {
      dynamicRegistration: true,
      completionItem: {
        snippetSupport: true,
        resolveSupport: { properties: ["additionalTextEdits"] },
        documentationFormat: ["markdown", "plaintext"],
      },
    },
    definition: { dynamicRegistration: true },
    references: { dynamicRegistration: true },
    implementation: { dynamicRegistration: true },
    rename: { dynamicRegistration: true, prepareSupport: true },
    documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
    formatting: { dynamicRegistration: true },
    foldingRange: { dynamicRegistration: true },
    inlayHint: { dynamicRegistration: true },
    codeLens: { dynamicRegistration: true },
    codeAction: {
      dynamicRegistration: true,
      dataSupport: true,
      resolveSupport: { properties: ["edit"] },
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: ["quickfix", "refactor", "refactor.extract", "refactor.inline", "source"],
        },
      },
    },
  },
};

/** The Monaco client's side of the connection, over the server's real WebSocket route. */
class LspClient {
  readonly messages: RpcMessage[] = [];
  private readonly versions = new Map<string, number>();
  private nextId = 1;
  private readonly pending = new Map<number, (message: RpcMessage) => void>();
  private readonly waiters: { test: (m: RpcMessage) => boolean; done: (m: RpcMessage) => void }[] =
    [];

  constructor(
    private readonly ws: WebSocket,
    readonly root: string,
  ) {
    ws.addEventListener("close", ({ code, reason }) => {
      if (code !== 1000) console.error(`     the server's socket closed: ${code} ${reason}`);
    });
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as RpcMessage;
      if (message.method === undefined && message.id !== undefined) {
        const resolve = this.pending.get(message.id);
        if (typeof resolve === "function") resolve(message);
        return;
      }
      this.messages.push(message);
      if (message.id !== undefined) this.notify({ id: message.id, result: null });
      for (const waiter of this.waiters.filter(({ test }) => test(message))) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.done(message);
      }
    });
  }

  notify(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  request(method: string, params: unknown): Promise<RpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No reply to ${method}`)),
        REQUEST_TIMEOUT_MS,
      );
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.notify({ id, method, params });
    });
  }

  waitFor(test: (message: RpcMessage) => boolean): Promise<RpcMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out")), REQUEST_TIMEOUT_MS);
      this.waiters.push({
        test,
        done: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }

  onClose(listener: (code: number) => void): void {
    this.ws.addEventListener("close", ({ code }) => listener(code));
  }

  uri(relative: string): string {
    return `file://${path.join(this.root, relative)}`;
  }

  /** Open a file and wait for its next diagnostics. */
  async open(relative: string): Promise<{ text: string; diagnostics: Diagnostic[] }> {
    const text = readFileSync(path.join(this.root, relative), "utf8");
    const uri = this.uri(relative);
    const published = this.waitFor(
      (m) => m.method === "textDocument/publishDiagnostics" && m.params?.uri === uri,
    );
    this.versions.set(uri, 1);
    this.notify({
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "java", version: 1, text } },
    });
    return { text, diagnostics: (await published).params?.diagnostics ?? [] };
  }

  /** Replace a file's text and wait for its next diagnostics. */
  async change(relative: string, text: string): Promise<Diagnostic[]> {
    const uri = this.uri(relative);
    const published = this.waitFor(
      (m) => m.method === "textDocument/publishDiagnostics" && m.params?.uri === uri,
    );
    const version = (this.versions.get(uri) ?? 1) + 1;
    this.versions.set(uri, version);
    this.notify({
      method: "textDocument/didChange",
      params: { textDocument: { uri, version }, contentChanges: [{ text }] },
    });
    return (await published).params?.diagnostics ?? [];
  }
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)));
  });
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const up = await fetch(url).then(
      () => true,
      () => false,
    );
    if (up) return;
    await Bun.sleep(100);
  }
  throw new Error("loxel-server did not start");
}

function positionOf(text: string, needle: string, offset = 0): Position {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`Fixture has no ${needle}`);
  const lines = text.slice(0, index + offset).split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const offset = ({ line, character }: Position): number => {
    const lines = text.split("\n").slice(0, line);
    return lines.reduce((sum, l) => sum + l.length + 1, 0) + character;
  };
  const ordered = edits.toSorted((a, b) => offset(b.range.start) - offset(a.range.start));
  let result = text;
  for (const edit of ordered) {
    result =
      result.slice(0, offset(edit.range.start)) +
      edit.newText +
      result.slice(offset(edit.range.end));
  }
  return result;
}

const work = realpathSync(mkdtempSync(path.join(tmpdir(), "jdtls-audit-")));
process.on("exit", () => {
  if (values.keep) console.log(`     kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
});
const dylib = path.join(work, "connect-log.dylib");
const logPath = path.join(work, "connections.log");
await $`clang -dynamiclib -w -o ${dylib} ${path.join(import.meta.dir, "connect-log.c")} -lresolv`;

// The server finds language servers next to itself. An ad-hoc signature drops the hardened runtime
// of a signed server, which would ignore the logger; the runtime's `java` allows it by entitlement.
const serverPath = path.join(work, "loxel-server");
copyFileSync(path.join(BUILD, "loxel-server"), serverPath);
await $`codesign -s - -f ${serverPath}`.quiet();
symlinkSync(path.join(BUILD, "jdtls"), path.join(work, "jdtls"));
if (!process.env.JAVA_HOME) throw new Error("Set JAVA_HOME to a JDK 25 or newer");
const realHome = process.env.JAVA_HOME;
const realJava = path.join(realHome, "bin", "java");
let auditedHome = realHome;
const auditHome = path.join(work, "home");
if (values.control || values.trusted) {
  // The same JDK, with a `java` that drops the flag on the way when this is the control, and keeps
  // `~/.m2` and the like out of the real home: Java does not read HOME for it.
  auditedHome = path.join(work, "control-jdk");
  let target = realJava;
  if (values.trusted) {
    // A copy, since Gradle refuses a daemon whose `java.home` isn't the JDK it was told to use.
    await $`cp -c -R ${realHome} ${auditedHome}`;
    target = path.join(auditedHome, "bin", "java-audited");
    renameSync(path.join(auditedHome, "bin", "java"), target);
  } else {
    mkdirSync(path.join(auditedHome, "bin"), { recursive: true });
    for (const entry of ["release", "lib", "conf", "legal"]) {
      symlinkSync(path.join(realHome, entry), path.join(auditedHome, entry));
    }
    symlinkSync(path.join(realHome, "bin", "javac"), path.join(auditedHome, "bin", "javac"));
  }
  const wrapper = path.join(auditedHome, "bin", "java");
  // bash is a system binary, so the dynamic linker drops the logger's variables going through it.
  writeFileSync(
    wrapper,
    `#!/bin/bash
args=(-Duser.home='${auditHome}')
${values.control ? 'for a in "$@"; do [[ "$a" == -Djdk.net.hosts.file=* ]] || args+=("$a"); done\nunset JAVA_TOOL_OPTIONS' : 'args+=("$@")'}
export DYLD_INSERT_LIBRARIES='${dylib}' CONNECT_LOG='${logPath}'
exec '${target}' "\${args[@]}"
`,
  );
  chmodSync(wrapper, 0o755);
}

mkdirSync(path.join(auditHome, ".jdks"), { recursive: true });
if (values.m2) {
  mkdirSync(path.join(auditHome, ".m2"));
  symlinkSync(values.m2, path.join(auditHome, ".m2", "repository"));
}
symlinkSync(auditedHome, path.join(auditHome, ".jdks", "audited"));

const markers = path.join(work, "markers");
mkdirSync(markers);

async function gitInit(root: string): Promise<void> {
  await $`git init -q ${root}`;
  await $`git -C ${root} add -A`;
  await $`git -C ${root} -c user.name=audit -c user.email=audit@example.invalid commit -qm fixture`;
}

const APP = `package app;
import java.util.List;
public class App {
  public static void main(String[] args) {
    List<String> items = List.of("a");
    System.out.println(items.getFirst());
  }
}
`;

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** A jar whose annotation processor leaves a marker when loaded, built with jdtls's own compiler. */
async function buildProcessorJar(): Promise<string> {
  const dir = path.join(work, "processor");
  writeFiles(dir, {
    "canary/Proc.java": `package canary;
import java.util.Set;
import javax.annotation.processing.*;
import javax.lang.model.SourceVersion;
import javax.lang.model.element.TypeElement;
@SupportedAnnotationTypes("*")
public class Proc extends AbstractProcessor {
  static {
    try { java.nio.file.Files.writeString(java.nio.file.Path.of(${JSON.stringify(path.join(markers, "processor"))}), "ran"); } catch (Exception e) {}
  }
  @Override public SourceVersion getSupportedSourceVersion() { return SourceVersion.latest(); }
  @Override public boolean process(Set<? extends TypeElement> a, RoundEnvironment r) { return false; }
}
`,
    "META-INF/services/javax.annotation.processing.Processor": "canary.Proc\n",
  });
  const plugins = path.join(BUILD, "jdtls", "plugins");
  const compiler = readdirSync(plugins).find((f) =>
    f.startsWith("org.eclipse.jdt.core.compiler.batch_"),
  );
  if (!compiler) throw new Error("jdtls has no batch compiler");
  await $`${realJava} -jar ${path.join(plugins, compiler)} -proc:none -nowarn -21 -d ${dir} ${path.join(dir, "canary/Proc.java")}`.quiet();
  const jar = path.join(work, "proc.jar");
  await $`zip -qr ${jar} canary META-INF`.cwd(dir).quiet();
  return jar;
}

/** Projects with build logic of every kind jdtls knows, each leaving a marker if it runs. */
function projectFixtures(jar: string): Record<string, () => void> {
  const appFile = { "src/main/java/app/App.java": APP };
  const marker = (name: string) => path.join(markers, name);
  const script = (name: string) => `#!/bin/sh\necho ran > ${marker(name)}\n`;
  return {
    gradle: () => {
      const root = path.join(work, "gradle");
      writeFiles(root, {
        ...appFile,
        "settings.gradle": `new File("${marker("gradle-settings")}").text = "ran"\nrootProject.name = "c"\n`,
        "build.gradle": `new File("${marker("gradle-build")}").text = "ran"\napply plugin: 'java'\n`,
        gradlew: script("gradlew"),
        "gradle/wrapper/gradle-wrapper.properties":
          "distributionUrl=http\\://127.0.0.1\\:9/gradle.zip\n",
      });
      chmodSync(path.join(root, "gradlew"), 0o755);
    },
    maven: () => {
      const root = path.join(work, "maven");
      writeFiles(root, {
        ...appFile,
        ".mvn/extensions.xml":
          "<extensions><extension><groupId>c</groupId><artifactId>c</artifactId><version>1</version></extension></extensions>\n",
        mvnw: script("mvnw"),
        ".mvn/wrapper/maven-wrapper.properties": "distributionUrl=http://127.0.0.1:9/maven.zip\n",
        "pom.xml": `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>c</groupId><artifactId>c</artifactId><version>1</version><build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-antrun-plugin</artifactId><version>3.1.0</version><executions><execution><phase>generate-sources</phase><goals><goal>run</goal></goals><?m2e execute onConfiguration,onIncremental?><configuration><target><touch file="${marker("m2e")}"/></target></configuration></execution></executions></plugin></plugins></build></project>\n`,
      });
      chmodSync(path.join(root, "mvnw"), 0o755);
    },
    eclipse: () => {
      const root = path.join(work, "eclipse");
      writeFiles(root, {
        ...appFile,
        ".project":
          '<?xml version="1.0"?><projectDescription><name>c</name><comment/><projects/><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>\n',
        ".classpath":
          '<?xml version="1.0"?><classpath><classpathentry kind="src" path="src/main/java"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="lib" path="lib/proc.jar"/><classpathentry kind="output" path="bin"/></classpath>\n',
        ".factorypath":
          '<factorypath><factorypathentry kind="WKSPJAR" id="/c/lib/proc.jar" enabled="true" runInBatchMode="false"/></factorypath>\n',
        ".settings/org.eclipse.jdt.apt.core.prefs":
          "eclipse.preferences.version=1\norg.eclipse.jdt.apt.aptEnabled=true\norg.eclipse.jdt.apt.reconcileEnabled=true\n",
        ".settings/org.eclipse.jdt.core.prefs":
          "eclipse.preferences.version=1\norg.eclipse.jdt.core.compiler.processAnnotations=enabled\n",
      });
      mkdirSync(path.join(root, "lib"));
      copyFileSync(jar, path.join(root, "lib/proc.jar"));
    },
    plain: () => {
      const root = path.join(work, "plain");
      writeFiles(root, appFile);
      mkdirSync(path.join(root, "lib"));
      copyFileSync(jar, path.join(root, "lib/proc.jar"));
    },
  };
}

const SHAPES: Record<string, string> = {
  "src/shapes/Shape.java": `package shapes;
public interface Shape {
  double area();
}
`,
  "src/shapes/Circle.java": `package shapes;
public class Circle implements Shape {
  private final double radius;
  public Circle(double radius) { this.radius = radius; }
  @Override public double area() { return Math.PI * radius * radius; }
}
`,
  "src/shapes/Outer$Inner.java": `package shapes;
class Outer$Inner { static final String PRICE$USD = "$5"; int a$b; }
`,
  "src/shapes/Use.java": `package shapes;
class Use {
  Circle circle = new Circle(1);
}
`,
  "src/shapes/App.java": `package shapes;
import java.util.Map;
public class App implements Shape, Runnable {
  private int count;
  private String name;
  void work() throws Exception {
    ArrayList<String> list = new ArrayList<>();
    String s = "literal";
    int n = 1 + 2;
    new java.io.FileReader("x");
    new Circle(1);
    Outer$Inner inner = new Outer$Inner();
    inner.
    System.out.println(s + n);
    missing();
  }
  void caller() { work(); }
}
`,
};

const dekFile = path.join(work, "dek");
writeFileSync(dekFile, randomBytes(32).toString("base64"));

const port = 20_000 + Math.floor(Math.random() * 20_000);
const server = Bun.spawn([serverPath], {
  stdout: "ignore",
  stderr: "ignore",
  env: {
    ...process.env,
    CONNECT_LOG: logPath,
    DYLD_INSERT_LIBRARIES: dylib,
    // The server finds the audited JDK among the install locations of a home of its own.
    HOME: auditHome,
    JAVA_HOME: "",
    LOXEL_DEK_FILE: dekFile,
    LOXEL_SERVE_PORT: String(port),
    LOXEL_STATE_DIR: path.join(work, "state"),
    ...(values.trusted
      ? { GRADLE_USER_HOME: values["gradle-home"] ?? path.join(auditHome, ".gradle") }
      : {}),
  },
});

const failures: string[] = [];
function check(ok: boolean, label: string, detail?: unknown): void {
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
  );
  if (!ok) failures.push(label);
}

async function startClient(root: string): Promise<LspClient> {
  const url = `ws://127.0.0.1:${port}/ws/java-lsp?wt=${encodeURIComponent(root)}`;
  const client = new LspClient(await connect(url), root);
  const ready = client.waitFor(
    (m) => m.method === "language/status" && m.params?.type === "ServiceReady",
  );
  const init = await client.request("initialize", {
    processId: null,
    rootUri: null,
    clientInfo: { name: "network-audit", version: "0" },
    capabilities: CLIENT_CAPABILITIES,
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  client.notify({ method: "initialized", params: {} });
  await ready;
  return client;
}

async function stopClient(client: LspClient): Promise<void> {
  await client.request("shutdown", null);
  client.notify({ method: "exit" });
}

/** Everything a user can start, on a project jdtls fully understands. */
async function exerciseFeatures(): Promise<void> {
  const root = path.join(work, "shapes");
  writeFiles(root, SHAPES);
  await gitInit(root);
  const client = await startClient(root);
  const file = "src/shapes/App.java";
  const uri = client.uri(file);
  const textDocument = { uri };
  const { text, diagnostics } = await client.open(file);
  const commands = new Set<string>();
  check(
    diagnostics.some((d) => d.message.includes("missing()")),
    "type errors are reported",
    diagnostics.map((d) => d.message),
  );

  const at = (needle: string, offset = 1) => positionOf(text, needle, offset);
  const say = (label: string, value: unknown) =>
    console.log(`     ${label}: ${JSON.stringify(value)?.slice(0, 400)}`);
  for (const [name, method, position] of [
    ["hover JDK", "textDocument/hover", at("FileReader")],
    ["hover own", "textDocument/hover", at("Circle")],
    ["definition JDK", "textDocument/definition", at("FileReader")],
    ["definition own", "textDocument/definition", at("Circle")],
    ["implementation", "textDocument/implementation", at("Shape")],
  ] as const) {
    say(name, (await client.request(method, { textDocument, position })).result);
  }
  say(
    "references",
    (
      (
        await client.request("textDocument/references", {
          textDocument,
          position: at("Circle"),
          context: { includeDeclaration: true },
        })
      ).result as unknown[]
    )?.length,
  );
  say(
    "symbols",
    ((await client.request("textDocument/documentSymbol", { textDocument })).result as unknown[])
      ?.length,
  );
  say(
    "workspace symbols",
    ((await client.request("workspace/symbol", { query: "Circle" })).result as unknown[])?.length,
  );
  say(
    "folding",
    ((await client.request("textDocument/foldingRange", { textDocument })).result as unknown[])
      ?.length,
  );
  say(
    "semantic tokens",
    (await client.request("textDocument/semanticTokens/full", { textDocument })).result !== null,
  );
  await client.open("src/shapes/Use.java");
  say(
    "inlay hints",
    (
      await client.request("textDocument/inlayHint", {
        textDocument: { uri: client.uri("src/shapes/Use.java") },
        range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } },
      })
    ).result,
  );
  const lenses = (await client.request("textDocument/codeLens", { textDocument })).result as
    | { command?: Command }[]
    | null;
  say("code lenses", lenses?.length);
  for (const lens of lenses ?? []) {
    const resolved = (await client.request("codeLens/resolve", lens)).result as {
      command?: Command;
    } | null;
    say("code lens", resolved?.command);
    if (resolved?.command) commands.add(resolved.command.command);
  }
  say(
    "format edits",
    (
      (
        await client.request("textDocument/formatting", {
          textDocument,
          options: { tabSize: 2, insertSpaces: true },
        })
      ).result as unknown[]
    )?.length,
  );
  const rename = (
    await client.request("textDocument/rename", {
      textDocument,
      position: at("Circle"),
      newName: "Disc",
    })
  ).result as { documentChanges?: { kind?: string }[] } | null;
  say("rename changes", rename?.documentChanges?.length);

  // Completions: what the client inserts, and the command each carries.
  const complete = async (edited: string, needle: string): Promise<CompletionItem[]> => {
    await client.change(file, edited);
    const result = (
      await client.request("textDocument/completion", {
        textDocument,
        position: positionOf(edited, needle, needle.length),
      })
    ).result as { items?: CompletionItem[] } | null;
    return result?.items ?? [];
  };
  const inserted = (item: CompletionItem) =>
    item.textEdit?.newText ?? item.insertText ?? item.label;
  const members = await complete(text, "inner.");
  for (const item of members.filter((i) => i.label.includes("$"))) {
    say(`completion ${item.label}`, { text: inserted(item), format: item.insertTextFormat });
  }
  const types = await complete(text.replace("inner.\n", "Outer\n"), "Outer");
  say(
    "type completion",
    types
      .slice(0, 3)
      .map((i) => ({ label: i.label, text: inserted(i), format: i.insertTextFormat })),
  );
  const sysout = await complete(text.replace("inner.\n", "sysout\n"), "sysout");
  say(
    "sysout",
    sysout
      .slice(0, 2)
      .map((i) => ({ label: i.label, text: inserted(i), format: i.insertTextFormat })),
  );
  const call = await complete(text.replace("inner.\n", "s.substr\n"), "s.substr");
  say(
    "argument placeholders",
    call.slice(0, 2).map((i) => ({ text: inserted(i), format: i.insertTextFormat })),
  );
  const imports = await complete(text.replace("inner.\n", "LinkedLis\n"), "LinkedLis");
  const linked = imports.find((i) => i.label.startsWith("LinkedList"));
  say("auto-import before resolve", linked?.additionalTextEdits);
  if (linked) {
    const resolved = (await client.request("completionItem/resolve", linked))
      .result as CompletionItem;
    say("auto-import after resolve", resolved.additionalTextEdits);
    if (resolved.command) {
      commands.add(resolved.command.command);
      const done = await client.request("workspace/executeCommand", resolved.command);
      say(`executed ${resolved.command.command}`, done.error ?? "ok");
    }
  }
  await client.change(file, text);

  // Every code action on offer, resolved and applied.
  const ranges: Range[] = [
    ...diagnostics.map((d) => d.range),
    ...["class App", "int count", "String name", "void work", '"literal"', "1 + 2"].map(
      (needle) => {
        const position = at(needle);
        return { start: position, end: position };
      },
    ),
  ];
  // jdtls resolves only the actions of its latest answer, so each is resolved before the next ask.
  const seen = new Set<string>();
  for (const range of ranges) {
    const context = { diagnostics: diagnostics.filter((d) => d.range === range) };
    const offered = (
      await client.request("textDocument/codeAction", { textDocument, range, context })
    ).result as CodeAction[] | null;
    for (const candidate of offered ?? []) {
      if (seen.has(candidate.title)) continue;
      seen.add(candidate.title);
      const resolved =
        candidate.data && !candidate.edit
          ? await client.request("codeAction/resolve", candidate)
          : { result: candidate };
      const action = resolved.result as CodeAction | null | undefined;
      check(
        Boolean(action),
        `action resolves: ${candidate.title}`,
        "error" in resolved ? resolved.error : undefined,
      );
      if (!action) continue;
      const edits = [
        ...(action.edit?.documentChanges ?? [])
          .filter((c) => c.textDocument?.uri === uri)
          .flatMap((c) => c.edits ?? []),
        ...(action.edit?.changes?.[uri] ?? []),
      ];
      const otherFiles =
        (action.edit?.documentChanges ?? []).length +
        Object.keys(action.edit?.changes ?? {}).length;
      say(`action ${candidate.title}`, {
        kind: candidate.kind,
        applied: applyEdits(text, edits) !== text,
        editedFiles: otherFiles,
        command: action.command?.command,
      });
      if (action.command) {
        commands.add(action.command.command);
        const done = await client.request("workspace/executeCommand", action.command);
        say(`executed ${action.command.command}`, done.error ?? "ok");
      }
    }
  }
  check(seen.size > 0, "code actions are offered", seen.size);
  say("commands reached", [...commands]);
  check((await $`git -C ${root} status --porcelain`.text()).trim() === "", "the tree stays clean");
  await stopClient(client);
}

/** Opening and editing a file in a project with build logic: none of it runs, its files stay. */
/**
 * Library sources: go to definition on JDK and dependency classes, with and without attached source,
 * then read each document, open it and use it the way a read-only tab does.
 */
async function exerciseLibrarySources(): Promise<void> {
  const root = path.join(work, "libraries");
  const app = `package app;

import dep.Bare;
import dep.Attached;
import java.util.List;

public class App {
  List<String> jdk;
  Attached attached;
  Bare bare;
}
`;
  writeFiles(root, { "src/app/App.java": app });
  const jars = path.join(work, "library-jars");
  writeFiles(jars, {
    "dep/Attached.java":
      "package dep;\n/** Documented. */\npublic class Attached { public Bare bare; }\n",
    "dep/Bare.java": "package dep;\npublic class Bare {}\n",
  });
  await $`${path.join(realHome, "bin", "javac")} -d out dep/Attached.java dep/Bare.java`
    .cwd(jars)
    .quiet();
  mkdirSync(path.join(root, "lib"), { recursive: true });
  await $`zip -qr ${path.join(root, "lib/attached.jar")} dep/Attached.class`
    .cwd(path.join(jars, "out"))
    .quiet();
  await $`zip -qr ${path.join(root, "lib/bare.jar")} dep/Bare.class`
    .cwd(path.join(jars, "out"))
    .quiet();
  await $`zip -qr ${path.join(root, "lib/attached-sources.jar")} dep/Attached.java`
    .cwd(jars)
    .quiet();
  await gitInit(root);

  const client = await startClient(root);
  const textDocument = { uri: client.uri("src/app/App.java") };
  await client.open("src/app/App.java");
  for (const [name, needle, expected] of [
    ["JDK class", "List<String>", "public interface List"],
    ["dependency with sources", "Attached attached", "Documented."],
    ["dependency without sources", "Bare bare", "decompiled"],
  ] as const) {
    const target = (await client.request("textDocument/definition", {
      textDocument,
      position: positionOf(app, needle, 1),
    })) as { result?: Array<{ uri?: string; range?: Range }> };
    const location = target.result?.[0];
    check(location?.uri?.startsWith("jdt://") === true, `${name}: definition leads to its source`);
    if (!location?.uri || !location.range) continue;
    const document = { uri: location.uri };
    const content = await client.request("workspace/textDocumentContent", document);
    const text = (content.result as { text?: string } | undefined)?.text ?? "";
    check(text.includes(expected), `${name}: its text is available`, text.slice(0, 80));
    client.notify({
      method: "textDocument/didOpen",
      params: { textDocument: { ...document, languageId: "java", version: 1, text } },
    });
    const position = location.range.start;
    const hover = await client.request("textDocument/hover", { textDocument: document, position });
    check(hover.result !== null && !hover.error, `${name}: hover inside it`);
    await client.request("textDocument/definition", { textDocument: document, position });
    await client.request("textDocument/documentSymbol", { textDocument: document });
    await client.request("textDocument/semanticTokens/full", { textDocument: document });
    await client.request("textDocument/references", {
      textDocument: document,
      position,
      context: { includeDeclaration: true },
    });
    client.notify({ method: "textDocument/didClose", params: { textDocument: document } });
  }
  await client.request("workspace/symbol", { query: "Attached" });
  await stopClient(client);
}

async function exerciseProjects(jar: string): Promise<void> {
  for (const [name, write] of Object.entries(projectFixtures(jar))) {
    write();
    const root = path.join(work, name);
    await gitInit(root);
    const client = await startClient(root);
    const file = "src/main/java/app/App.java";
    const { text } = await client.open(file);
    const edited = text.replace("List.of", "java.util.List.of");
    const diagnostics = await client.change(file, `${edited}class Lib { canary.Proc proc; }\n`);
    if (name === "plain") {
      check(
        !diagnostics.some((d) => d.message.includes("canary")),
        "plain: jars in lib/ are on the classpath",
        diagnostics.map((d) => d.message),
      );
    }
    await stopClient(client);
    check(
      readdirSync(markers).length === 0,
      `${name}: nothing from the project ran`,
      readdirSync(markers),
    );
    check(
      (await $`git -C ${root} status --porcelain`.text()).trim() === "",
      `${name}: the tree stays clean`,
    );
  }
}

const api = `http://127.0.0.1:${port}/api`;

async function post(route: string, body: unknown): Promise<void> {
  const response = await fetch(`${api}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
}

async function projectIssueOf(root: string): Promise<{ detail: string } | null> {
  const response = await fetch(`${api}/java-env?wt=${encodeURIComponent(root)}`);
  const { projectIssue } = (await response.json()) as { projectIssue: { detail: string } | null };
  return projectIssue;
}

/** The server's report comes in its own time; give it until `done`, then answer anyway. */
async function waitForIssue(
  root: string,
  done: (issue: { detail: string } | null) => boolean,
): Promise<{ detail: string } | null> {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  let issue = await projectIssueOf(root);
  while (!done(issue) && Date.now() < deadline) {
    await Bun.sleep(250);
    issue = await projectIssueOf(root);
  }
  return issue;
}

const MAIN_FILE = "src/main/java/app/App.java";
const TRUSTED_SOURCES = {
  [MAIN_FILE]: `package app;
public class App {
  int size = Helper.size();
  int wrong = "text";
}
`,
  "src/main/java/app/Helper.java": `package app;
class Helper {
  static int size() { return 1; }
}
`,
};

/** A repository of `files` the user trusts. */
async function trustedRepo(name: string, files: Record<string, string>): Promise<string> {
  const root = path.join(work, name);
  writeFiles(root, {
    ...TRUSTED_SOURCES,
    ".gitignore": "build/\ntarget/\nbin/\n.gradle/\n",
    ...files,
  });
  await gitInit(root);
  await post("/projects", { path: root });
  await post("/repo-trust", { worktreePath: root, trusted: true });
  return root;
}

const NO_ROOM_POM = `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>c</groupId><artifactId>c</artifactId><version>1</version><properties><maven.compiler.release>21</maven.compiler.release></properties>`;

/** The running daemons a server has registered, from the logs Gradle names by their ids. */
async function registeredDaemonPids(): Promise<number[]> {
  const logs = await $`find ${path.join(work, "state")} -name 'daemon-*.out.log'`.text();
  return logs
    .split("\n")
    .filter(Boolean)
    .map((log) => Number(/daemon-(\d+)/.exec(log)?.[1]));
}

async function waitForExit(pids: number[]): Promise<number[]> {
  const running = (pid: number) =>
    $`ps -p ${pid}`
      .nothrow()
      .quiet()
      .then((r) => r.exitCode === 0);
  let alive = pids;
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (alive.length > 0 && Date.now() < deadline) {
    await Bun.sleep(250);
    const flags = await Promise.all(alive.map(running));
    alive = alive.filter((_, i) => flags[i]);
  }
  return alive;
}

/** Features across files on a project that loaded, and the tree it leaves. */
async function checkLoaded(name: string, root: string, expectDaemon = false): Promise<void> {
  const client = await startClient(root);
  const { text, diagnostics } = await client.open(MAIN_FILE);
  const messages = diagnostics.map((d) => d.message);
  check(
    messages.some((m) => m.includes("cannot convert from String to int")),
    `${name}: type errors are reported`,
    messages,
  );
  const definition = (
    await client.request("textDocument/definition", {
      textDocument: { uri: client.uri(MAIN_FILE) },
      position: positionOf(text, "Helper.size", 1),
    })
  ).result as { uri: string }[] | null;
  check(
    definition?.[0]?.uri.endsWith("Helper.java") === true,
    `${name}: definition crosses files`,
    definition,
  );
  check((await projectIssueOf(root)) === null, `${name}: nothing to tell the user`);
  const daemons = await registeredDaemonPids();
  if (expectDaemon) check(daemons.length > 0, `${name}: a daemon runs`, daemons);
  await stopClient(client);
  const alive = await waitForExit(daemons);
  check(alive.length === 0, `${name}: no daemon outlives its server`, alive);
  const status = await $`git -C ${root} status --porcelain --ignored`.text();
  check(
    !/\.(project|classpath|settings|factorypath)/.test(status),
    `${name}: no IDE metadata in the tree`,
    status.split("\n").filter(Boolean),
  );
}

async function exerciseTrusted(): Promise<void> {
  const name = "tr-maven-missing";
  const root = await trustedRepo(name, {
    "pom.xml": `${NO_ROOM_POM}<repositories><repository><id>byip</id><url>http://192.0.2.10/repo</url></repository><repository><id>byname</id><url>https://canary-repo.example/repo</url></repository></repositories><dependencies><dependency><groupId>canary</groupId><artifactId>dep</artifactId><version>1</version></dependency></dependencies></project>\n`,
  });
  const client = await startClient(root);
  const issue = await waitForIssue(root, (i) => i?.detail.includes("mvn") === true);
  check(issue?.detail.includes("mvn test-compile") === true, `${name}: says what to run`, issue);
  await stopClient(client);

  const nodist = "tr-gradle-no-distribution";
  const nodistRoot = await trustedRepo(nodist, {
    "build.gradle": `new File("${path.join(markers, "nodist-build")}").text = "ran"\napply plugin: 'java'\n`,
    "settings.gradle": `rootProject.name = "c"\n`,
    gradlew: `#!/bin/sh\necho ran > ${path.join(markers, "gradlew")}\n`,
    "gradle/wrapper/gradle-wrapper.properties":
      "distributionUrl=https\\://canary-dist.example/gradle-0.0.1-bin.zip\n",
  });
  const nodistClient = await startClient(nodistRoot);
  const nodistIssue = await waitForIssue(nodistRoot, (i) => i !== null);
  check(
    nodistIssue?.detail.includes("./gradlew once") === true,
    `${nodist}: says what to run`,
    nodistIssue,
  );
  await stopClient(nodistClient);
  check(readdirSync(markers).length === 0, `${nodist}: nothing ran`, readdirSync(markers));
  const gradleHome = values["gradle-home"] ?? path.join(auditHome, ".gradle");
  check(
    !existsSync(path.join(gradleHome, "wrapper", "dists", "gradle-0.0.1-bin")),
    `${nodist}: no download started`,
  );

  if (values.m2) {
    const maven = "tr-maven";
    await checkLoaded(maven, await trustedRepo(maven, { "pom.xml": `${NO_ROOM_POM}</project>\n` }));
  }

  if (!values["gradle-url"]) return;
  const wrapper = `distributionUrl=${values["gradle-url"].replace(":", "\\:")}\n`;
  const gradle = "tr-gradle";
  const gradleRoot = await trustedRepo(gradle, {
    "build.gradle": "plugins { id 'java' }\n",
    "settings.gradle": `rootProject.name = "c"\n`,
    "gradle/wrapper/gradle-wrapper.properties": wrapper,
  });
  await checkLoaded(gradle, gradleRoot, true);
  const canary = "tr-gradle-canaries";
  const canaryRoot = await trustedRepo(canary, {
    "settings.gradle": `pluginManagement { repositories { maven { url 'http://192.0.2.1/plugins'; allowInsecureProtocol = true } } }
try { java.net.InetAddress.getByName("canary-daemon.example") } catch (Exception e) {}
new File("${path.join(work, "settings-ran")}").text = "ran"
rootProject.name = "c"
`,
    "build.gradle": `buildscript { repositories { maven { url 'http://192.0.2.2/bs'; allowInsecureProtocol = true } }
  dependencies { classpath 'canary:bscp:1.0' } }
plugins { id 'java'; id 'canary.plugin' version '1.0' }
repositories { maven { url 'http://192.0.2.3/deps'; allowInsecureProtocol = true } }
dependencies { implementation 'canary:dep:1.0' }
`,
    "gradle/wrapper/gradle-wrapper.properties": wrapper,
  });
  const canaryClient = await startClient(canaryRoot);
  const canaryIssue = await waitForIssue(canaryRoot, (i) => i !== null);
  check(existsSync(path.join(work, "settings-ran")), `${canary}: its build ran`);
  check(canaryIssue !== null, `${canary}: reports the failed import`, canaryIssue);
  await stopClient(canaryClient);

  // Taking trust back restarts the server restricted.
  const revoked = await startClient(gradleRoot);
  await revoked.open(MAIN_FILE);
  const closed = new Promise((resolve) => {
    revoked.onClose(resolve);
  });
  await post("/repo-trust", { worktreePath: gradleRoot, trusted: false });
  console.log(`     revoking closed the connection: ${await closed}`);
  const restricted = await startClient(gradleRoot);
  const { diagnostics } = await restricted.open(MAIN_FILE);
  const messages = diagnostics.map((d) => d.message);
  check(
    !messages.some((m) => m.includes("cannot convert from String to int")),
    `${gradle}: revoked: back to the file on its own`,
    messages,
  );
  await stopClient(restricted);
}

try {
  await waitForServer(`http://127.0.0.1:${port}/`);
  if (values.trusted) {
    await exerciseTrusted();
  } else {
    const jar = await buildProcessorJar();
    await exerciseFeatures();
    await exerciseLibrarySources();
    if (!values.control) await exerciseProjects(jar);
  }
} finally {
  server.kill();
  await server.exited;
}

const all = readFileSync(logPath, { flag: "a+", encoding: "utf8" }).split("\n").filter(Boolean);
const logged = all.filter((line) => line.split(" ")[1] !== "loxel-server");
check(
  logged.some((line) => line.split(" ")[1]?.startsWith("java") && line.split(" ")[2] === "loaded"),
  "the logger loaded into java",
);
const lines = logged.filter((line) => line.split(" ")[2] !== "loaded");
const programs = new Set(logged.map((line) => line.split(" ")[1]));
console.log(`     programs logged: ${[...programs].join(", ")}`);
console.log(`     ${lines.length} socket events from them`);
for (const line of new Set(lines.map((entry) => entry.split(" ").slice(1).join(" ")))) {
  console.log(`     ${line}`);
}
const outbound = lines.filter((line) => line.endsWith(" BLOCKED"));
check(outbound.length === 0, "no outbound connection attempts", outbound.length);

if (failures.length > 0) {
  console.error(`AUDIT FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("AUDIT PASSED");
