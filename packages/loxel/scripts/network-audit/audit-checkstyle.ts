/**
 * Proves at the socket level that Checkstyle fetches nothing when it runs through Loxel's manager in
 * a trusted repository, whatever URLs a project's config names, and that a run writes nothing a
 * config asks for: no `cacheFile`, in or out of the repository, and a clean tree. macOS only. Run it
 * after changing the manager's spawn environment; it exits non-zero on any outbound attempt.
 *
 *   JAVA_HOME=<a JDK whose java allows DYLD, as Temurin's does> \\
 *     bun scripts/network-audit/audit-checkstyle.ts --jar <checkstyle-*-all.jar> [--control]
 *
 * `--control` has the launcher drop the JVM options that keep URLs from going anywhere. It is the
 * positive control and must fail, by attempting to reach the hosts the fixtures name.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
const REQUEST_TIMEOUT_MS = 120_000;

const { values } = parseArgs({
  options: {
    control: { type: "boolean", default: false },
    jar: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});
const jdk = process.env.JAVA_HOME;
if (!values.jar || !jdk) throw new Error("Set JAVA_HOME, and pass --jar <checkstyle-*-all.jar>");

interface RpcMessage {
  id?: number;
  method?: string;
  params?: {
    uri?: string;
    type?: number;
    message?: string;
    diagnostics?: { message: string; source: string; code?: string }[];
  };
  result?: unknown;
}

class LspClient {
  private nextId = 1;
  readonly messages: RpcMessage[] = [];
  private waiters: { test: (m: RpcMessage) => boolean; done: (m: RpcMessage) => void }[] = [];

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as RpcMessage;
      this.messages.push(message);
      for (const waiter of this.waiters.filter(({ test }) => test(message))) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.done(message);
      }
    });
  }

  async request(method: string, params: unknown): Promise<RpcMessage> {
    const id = this.nextId++;
    const reply = this.waitFor((m) => m.id === id);
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return reply;
  }

  notify(method: string, params: unknown): void {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  waitFor(test: (message: RpcMessage) => boolean): Promise<RpcMessage> {
    const seen = this.messages.find(test);
    if (seen) return Promise.resolve(seen);
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

  close(): void {
    this.ws.close();
  }
}

const work = realpathSync(mkdtempSync(path.join(tmpdir(), "checkstyle-audit-")));
process.on("exit", () => {
  if (values.keep) console.log(`     kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
});
const logPath = path.join(work, "connect.log");
const dylib = path.join(work, "connect-log.dylib");
await $`clang -dynamiclib -w -o ${dylib} ${path.join(import.meta.dir, "connect-log.c")} -lresolv`;

// A home of its own: its only `checkstyle` is a launcher like Homebrew's, which honours JAVA_HOME
// and loads the logger, and its only JDK is the one the manager should pick.
const home = path.join(work, "home");
const bin = path.join(home, "bin");
mkdirSync(bin, { recursive: true });
mkdirSync(path.join(home, ".jdks"));
symlinkSync(jdk, path.join(home, ".jdks", "audited"));
writeFileSync(
  path.join(bin, "checkstyle"),
  `#!/bin/bash
${values.control ? "unset JAVA_TOOL_OPTIONS\n" : ""}export DYLD_INSERT_LIBRARIES='${dylib}' CONNECT_LOG='${logPath}'
exec "\${JAVA_HOME:-/nonexistent}/bin/java" -jar '${values.jar}' "$@"
`,
  { mode: 0o755 },
);
for (const file of [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".bash_profile"]) {
  writeFileSync(path.join(home, file), `export PATH='${bin}':/usr/bin:/bin\n`);
}

const CHECKED = `package app;
public class App {
  static final int bad = 1;
}
`;

function config(body: string, doctype?: string): string {
  const declared =
    doctype ??
    '<!DOCTYPE module PUBLIC "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN" "https://checkstyle.org/dtds/configuration_1_3.dtd">';
  return `<?xml version="1.0"?>\n${declared}\n<module name="Checker">${body}<module name="TreeWalker"><module name="ConstantName"/></module></module>\n`;
}

const filter = (url: string) =>
  `<module name="SuppressionFilter"><property name="file" value="${url}"/></module>`;

/** Each config needs what it names in order to load, so each ends the run where it would fetch. */
const FETCHING_CONFIGS: Record<string, string> = {
  "suppressions-host": config(filter("http://canary-suppressions.example/s.xml")),
  "suppressions-https-host": config(filter("https://canary-tls.example/s.xml")),
  "suppressions-ip": config(filter("http://192.0.2.10/s.xml")),
  "suppressions-https-ip": config(filter("https://192.0.2.11/s.xml")),
  "suppressions-ftp-ip": config(filter("ftp://192.0.2.12/s.xml")),
  "suppressions-ftp-spelled": config(filter("&#102;tp://192.0.2.17/s.xml")),
  "suppressions-jar-ftp": config(filter("jar:ftp://192.0.2.18/s.jar!/s.xml")),
  "suppressions-url-ftp": config(filter("url:ftp://192.0.2.19/s.xml")),
  "suppressions-default-ftp": config(
    `<module name="SuppressionFilter"><property name="file" value="\${unset}" default="ftp://192.0.2.20/s.xml"/></module>`,
  ),
  "suppressions-jar-ip": config(filter("jar:http://192.0.2.13/s.jar!/s.xml")),
  header: config(
    '<module name="Header"><property name="headerFile" value="http://192.0.2.14/h.txt"/></module>',
  ),
  "import-control": config("").replace(
    '<module name="ConstantName"/>',
    '<module name="ImportControl"><property name="file" value="http://192.0.2.15/i.xml"/></module>',
  ),
  // A processing instruction holds the `<!--`, so a parser reads what follows it.
  "pi-hides-ftp": config(`<?x <!-- ?>${filter("ftp://192.0.2.23/s.xml")}`),
  "dtd-ftp": config(
    "",
    '<!DOCTYPE module PUBLIC "-//Canary//DTD Nothing//EN" "ftp://192.0.2.21/canary.dtd">',
  ),
  dtd: config(
    "",
    '<!DOCTYPE module PUBLIC "-//Canary//DTD Nothing//EN" "http://192.0.2.16/canary.dtd">',
  ),
};

function gitInit(root: string): Promise<unknown> {
  return $`git init -q && git add -A && git -c user.email=a@example.com -c user.name=audit commit -qm init`
    .cwd(root)
    .quiet();
}

async function fixture(name: string, configText: string, extra: Record<string, string> = {}) {
  const root = path.join(work, name);
  const files: Record<string, string> = {
    "build.gradle": "plugins { id 'java'; id 'checkstyle' }\n",
    "settings.gradle": `rootProject.name = "c"\n`,
    "config/checkstyle/checkstyle.xml": configText,
    "src/main/java/app/App.java": CHECKED,
    ...extra,
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  await gitInit(root);
  return root;
}

const dekFile = path.join(work, "dek");
writeFileSync(dekFile, randomBytes(32).toString("base64"));
const port = 20_000 + Math.floor(Math.random() * 20_000);
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, "src/server/index.ts"], {
  cwd: LOXEL,
  stdout: "ignore",
  stderr: "ignore",
  env: {
    ...process.env,
    HOME: home,
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

async function post(route: string, body: unknown): Promise<void> {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${route}: ${res.status} ${await res.text()}`);
}

async function open(root: string): Promise<{ client: LspClient; uri: string }> {
  await post("/api/projects", { path: root });
  await post("/api/repo-trust", { worktreePath: root, trusted: true });
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws/checkstyle-lsp?wt=${encodeURIComponent(root)}`,
  );
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  const client = new LspClient(ws);
  await client.request("initialize", { processId: null, rootUri: null, capabilities: {} });
  client.notify("initialized", {});
  const file = path.join(root, "src/main/java/app/App.java");
  const uri = `file://${file}`;
  client.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "java", version: 1, text: readFileSync(file, "utf8") },
  });
  return { client, uri };
}

async function isClean(root: string): Promise<boolean> {
  return (await $`git status --porcelain`.cwd(root).text()).trim() === "";
}

try {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (
    !(await fetch(base).then(
      () => true,
      () => false,
    ))
  ) {
    if (Date.now() > deadline) throw new Error("The server did not start");
    await Bun.sleep(100);
  }

  // A run that writes nothing a config names, and reads a relative file from outside the tree.
  const outside = path.join(work, "outside-cache");
  const clean = await fixture(
    "writes",
    config(
      `<property name="cacheFile" value="${outside}"/><property name="fileExtensions" value="java"/><module name="SuppressionFilter"><property name="file" value="config/checkstyle/s.xml"/></module>`,
    ),
    {
      "config/checkstyle/s.xml":
        '<?xml version="1.0"?><!DOCTYPE suppressions PUBLIC "-//Checkstyle//DTD SuppressionFilter Configuration 1.2//EN" "https://checkstyle.org/dtds/suppressions_1_2.dtd"><suppressions></suppressions>\n',
    },
  );
  const { client, uri } = await open(clean);
  const published = await client.waitFor(
    (m) => m.method === "textDocument/publishDiagnostics" && m.params?.uri === uri,
  );
  const [first] = published.params?.diagnostics ?? [];
  check(first?.source === "checkstyle" && first.code === "ConstantName", "it reports", first);
  check(!existsSync(outside), "no cacheFile outside the repository");
  check(await isClean(clean), "writes: the tree stays clean");
  client.close();

  const inTree = await fixture(
    "cache-in-tree",
    config(
      `<property value="build/cs.cache" name="cacheFile"></property><!-- cacheFile --><property name="charset" value="UTF-8"/>`,
    ),
  );
  const cached = await open(inTree);
  await cached.client.waitFor((m) => m.method === "textDocument/publishDiagnostics");
  check(!existsSync(path.join(inTree, "build/cs.cache")), "no cacheFile in the repository");
  check(await isClean(inTree), "cache: the tree stays clean");
  cached.client.close();

  // Other spellings of the same property: taken out, or the config isn't run at all.
  for (const [name, property] of [
    ["cache-spaces", `<property name=" cacheFile " value="${outside}"/>`],
    ["cache-char-ref", `<property value="${outside}" name="cache&#70;ile"/>`],
  ] as const) {
    const root = await fixture(name, config(property));
    const run = await open(root);
    await run.client.waitFor((m) => m.method === "textDocument/publishDiagnostics");
    check(!existsSync(outside), `${name}: no cacheFile`);
    run.client.close();
  }
  const attlist = await fixture(
    "cache-attlist",
    config(
      `<property value="${outside}"/>`,
      `<!DOCTYPE module PUBLIC "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN" "https://checkstyle.org/dtds/configuration_1_3.dtd" [<!ATTLIST property name NMTOKEN "cacheFile">]>`,
    ),
  );
  const attlistRun = await open(attlist);
  await attlistRun.client.waitFor((m) => m.method === "window/showMessage");
  check(!existsSync(outside), "cache-attlist: no cacheFile");
  attlistRun.client.close();

  const suppressionDtd = await fixture(
    "suppressions-doctype-ftp",
    config(filter("config/checkstyle/s.xml")),
    {
      "config/checkstyle/s.xml":
        '<?xml version="1.0"?><!DOCTYPE suppressions PUBLIC "-//Canary//Nothing//EN" "ftp://192.0.2.22/s.dtd"><suppressions/>\n',
    },
  );
  const suppressionRun = await open(suppressionDtd);
  await suppressionRun.client.waitFor((m) => m.method === "window/showMessage");
  suppressionRun.client.close();

  const custom = await fixture("custom-class", config('<module name="canary.NotOnTheClasspath"/>'));
  const customRun = await open(custom);
  const customNotice = await customRun.client.waitFor((m) => m.method === "window/showMessage");
  check(
    customNotice.params?.message?.includes("Unable to instantiate") === true,
    "custom check: says so",
  );
  customRun.client.close();

  for (const [name, text] of Object.entries(FETCHING_CONFIGS)) {
    const root = await fixture(name, text);
    const run = await open(root);
    const answer = await run.client.waitFor(
      (m) => m.method === "window/showMessage" || m.method === "textDocument/publishDiagnostics",
    );
    console.log(`     ${name}: ${(answer.params?.message ?? "reported").slice(0, 120)}`);
    check(await isClean(root), `${name}: the tree stays clean`);
    run.client.close();
  }
} finally {
  server.kill();
  await server.exited;
}

const all = readFileSync(logPath, { flag: "a+", encoding: "utf8" }).split("\n").filter(Boolean);
check(
  all.some((line) => line.split(" ")[1]?.startsWith("java") && line.split(" ")[2] === "loaded"),
  "the logger loaded into java",
);
const events = all.filter((line) => line.split(" ")[2] !== "loaded");
for (const line of new Set(events.map((entry) => entry.split(" ").slice(1).join(" ")))) {
  console.log(`     ${line}`);
}
const outbound = events.filter((line) => line.endsWith(" BLOCKED"));
check(outbound.length === 0, "no outbound connection attempts", outbound.length);

if (failures.length > 0) {
  console.error(`AUDIT FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("AUDIT PASSED");
