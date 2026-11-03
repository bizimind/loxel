import { mkdtempSync, rmSync, watch } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// d3's UMD build is imported by path: its exports map offers it only under a custom condition.
import _d3Script from "../node_modules/d3/dist/d3.min.js" with { type: "text" };
import _d3Notices from "../resources/d3/LICENSE" with { type: "text" };
import _networkGraphHtml from "../resources/network-graph/index.html" with { type: "text" };
import _treemapHtml from "../resources/treemap/index.html" with { type: "text" };
import { isLocalRequest } from "./local-request.ts";
import type { AnalysisPlugin, VizType } from "./plugin.ts";

const HTML: Record<VizType, string> = {
  treemap: _treemapHtml as unknown as string,
  "network-graph": _networkGraphHtml as unknown as string,
};

/** Path the pages load d3 from; must match the `<script src>` in each page. */
export const D3_SCRIPT_PATH = "/d3.min.js";

/**
 * d3's UMD build, embedded in the binary and served locally so `--web` makes no request off the
 * machine. Its licenses require their notices in every copy, so the notices of d3 and the modules
 * its build bundles (resources/d3/LICENSE) head the served script.
 */
export const D3_SCRIPT = `/*!\n${_d3Notices}*/\n${_d3Script}`;

// Injected before </body> — connects to the reload WebSocket and reloads on any message.
const RELOAD_SCRIPT = `<script>
(function(){
  const ws=new WebSocket(\`ws://\${location.host}/__reload\`);
  ws.onmessage=()=>location.reload();
})();
</script>`;

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

interface ServeOptions {
  plugin: AnalysisPlugin;
  workDir: string;
  args: Record<string, string>;
  port: number;
}

export async function serve(opts: ServeOptions): Promise<void> {
  const { plugin, workDir, args, port } = opts;

  const tmpDir = mkdtempSync(join(tmpdir(), "code-analysis-"));

  const cleanup = () => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  await runAndWrite(plugin, workDir, args, tmpDir);

  const html = buildHtml(plugin.meta.vizType);
  const clients = new Set<{ send(data: string): void }>();

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const servedPort = srv.port ?? port;
      if (!isLocalRequest(req, servedPort)) {
        return new Response(`Forbidden: open http://localhost:${servedPort}/ directly`, {
          status: 403,
        });
      }
      const { pathname } = new URL(req.url);

      if (pathname === "/__reload") {
        if (srv.upgrade(req)) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 426 });
      }
      if (pathname === "/" || pathname === "/index.html") {
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (pathname === D3_SCRIPT_PATH) {
        return new Response(D3_SCRIPT, {
          headers: { "Content-Type": "text/javascript; charset=utf-8" },
        });
      }
      if (pathname === "/data.json") {
        return new Response(Bun.file(join(tmpDir, "data.json")), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (pathname === "/config.json") {
        return new Response(Bun.file(join(tmpDir, "config.json")), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
      },
      close(ws) {
        clients.delete(ws);
      },
      message() {},
    },
  });

  // File watcher: re-run analysis on matching changes, then push reload to browsers.
  const globs = plugin.meta.watchGlobs.map((g) => new Bun.Glob(g));
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  let fsWatcher: ReturnType<typeof watch> | null = null;
  try {
    fsWatcher = watch(workDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (!globs.some((g) => g.match(filename))) return;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        debounceTimer = null;
        try {
          await runAndWrite(plugin, workDir, args, tmpDir);
          for (const ws of clients) ws.send("reload");
        } catch (err) {
          process.stderr.write(`[code-analysis] re-analysis failed: ${String(err)}\n`);
        }
      }, 300);
    });
  } catch (err) {
    process.stderr.write(`[code-analysis] live reload unavailable: ${String(err)}\n`);
  }

  // Block until Ctrl-C.
  await new Promise<void>((res) => {
    process.once("exit", res);
  });

  fsWatcher?.close();
  server.stop(true);
  cleanup();
}

export function buildHtml(vizType: VizType): string {
  return HTML[vizType].replace("</body>", `${RELOAD_SCRIPT}</body>`);
}

async function runAndWrite(
  plugin: AnalysisPlugin,
  workDir: string,
  args: Record<string, string>,
  tmpDir: string,
): Promise<void> {
  const [records, config] = await Promise.all([
    plugin.generate(workDir, args),
    Promise.resolve(plugin.buildConfig(workDir, args)),
  ]);
  await Promise.all([
    Bun.write(join(tmpDir, "data.json"), JSON.stringify(records)),
    Bun.write(join(tmpDir, "config.json"), JSON.stringify(config)),
  ]);
}
