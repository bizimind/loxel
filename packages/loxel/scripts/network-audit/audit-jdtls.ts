/**
 * Proves at the socket level that the bundled Eclipse JDT LS makes no network requests when it runs
 * behind the real `loxel-server`, through opening files and every command a user can start, and that
 * with project import off it runs nothing from the project and leaves the project's files alone.
 * macOS only. Run it after changing the server's pin, its runtime or its manager; it exits non-zero
 * on any outbound attempt.
 *
 *   pnpm -C packages/loxel run build:server:standalone
 *   JAVA_HOME=<a JDK 25+ whose java allows DYLD, as Temurin's does> \\
 *     bun scripts/network-audit/audit-jdtls.ts [--control]
 *
 * `--control` runs the server without the JVM flag that keeps host names from resolving. It is the
 * positive control and must fail, by attempting to reach the hosts jdtls contacts by default.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
const REQUEST_TIMEOUT_MS = 60_000;

const { values } = parseArgs({
  options: {
    control: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
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
        this.pending.get(message.id)?.(message);
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
if (values.control) {
  // The same JDK, with a `java` that drops the flag on the way.
  auditedHome = path.join(work, "control-jdk");
  mkdirSync(path.join(auditedHome, "bin"), { recursive: true });
  for (const entry of ["release", "lib", "conf", "legal"]) {
    symlinkSync(path.join(realHome, entry), path.join(auditedHome, entry));
  }
  symlinkSync(path.join(realHome, "bin", "javac"), path.join(auditedHome, "bin", "javac"));
  const wrapper = path.join(auditedHome, "bin", "java");
  // bash is a system binary, so the dynamic linker drops the logger's variables going through it.
  writeFileSync(
    wrapper,
    `#!/bin/bash
args=()
for a in "$@"; do [[ "$a" == -Djdk.net.hosts.file=* ]] || args+=("$a"); done
export DYLD_INSERT_LIBRARIES='${dylib}' CONNECT_LOG='${logPath}'
exec '${realJava}' "\${args[@]}"
`,
  );
  chmodSync(wrapper, 0o755);
}

const auditHome = path.join(work, "home");
mkdirSync(path.join(auditHome, ".jdks"), { recursive: true });
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

try {
  await waitForServer(`http://127.0.0.1:${port}/`);
  const jar = await buildProcessorJar();
  await exerciseFeatures();
  if (!values.control) await exerciseProjects(jar);
} finally {
  server.kill();
  await server.exited;
}

const all = readFileSync(logPath, { flag: "a+", encoding: "utf8" }).split("\n").filter(Boolean);
const logged = all.filter((line) => line.split(" ")[1] !== "loxel-server");
check(
  logged.some((line) => line.split(" ")[1] === "java" && line.split(" ")[2] === "loaded"),
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
