// Minimal vite config: serve the resources dir, inject piped stdin JSON into
// the page at startup (optional), and push a full reload whenever `data.json`
// or `config.json` next to index.html are rewritten.

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

export default async () => {
  let embedded = null;
  try {
    embedded = await readStdin();
    if (embedded) {
      const count = Array.isArray(embedded) ? embedded.length : "?";
      console.log(`[vite.config] embedded data from stdin (${count} records)`);
    }
  } catch (err) {
    console.warn("[vite.config] failed to parse stdin as JSON:", err.message);
  }

  return {
    optimizeDeps: { entries: ["index.html"] },
    plugins: [
      {
        name: "treemap",
        transformIndexHtml() {
          if (!embedded) return;
          // Escape `<` so a `</script>` substring can't close the inline script.
          const payload = JSON.stringify(embedded).replace(/</g, "\\u003c");
          return [
            {
              tag: "script",
              children: `window.__TREEMAP_DATA__ = ${payload};`,
              injectTo: "head-prepend",
            },
          ];
        },
        configureServer(server) {
          const root = server.config.root;
          const watched = [`${root}/data.json`, `${root}/config.json`];
          server.watcher.add(watched);
          const reload = (file) => {
            if (/\/(data|config)\.json$/.test(file)) {
              console.log(`[treemap] ${file.split("/").pop()} changed → reload`);
              server.ws.send({ type: "full-reload", path: "*" });
            }
          };
          server.watcher.on("change", reload);
          server.watcher.on("add", reload);
        },
      },
    ],
  };
};
