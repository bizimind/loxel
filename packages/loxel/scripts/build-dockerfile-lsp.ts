/**
 * Builds dockerfile-language-server-nodejs into a standalone Bun binary,
 * `build/docker-langserver`.
 *
 * Two-step process:
 *   1. Bun.build() of the package's server entry → single JS bundle
 *   2. bun build --compile on the resulting bundle → standalone binary
 *
 * Completing an image tag after `FROM <image>:` asks Docker Hub for the image's tags, with no
 * setting to stop it. The bundle replaces that registry client with one that has no tags, so the
 * binary holds no code that sends anything off the machine.
 */

import path from "node:path";

import { resolvePackage } from "./resolve-package";

const LOXEL = path.resolve(import.meta.dir, "..");
const OUTDIR = path.join(LOXEL, "build");
const INTERMEDIATE = path.join(OUTDIR, ".dockerfile-lsp-intermediate");

const serverDir = resolvePackage("dockerfile-language-server-nodejs");

// dockerfile-language-service's lib/dockerRegistryClient.js, which only dockerAssist.js uses, through
// `getTags(image, prefix)`.
const OFFLINE_REGISTRY_CLIENT = `
exports.DockerRegistryClient = class DockerRegistryClient {
  getTags() {
    return Promise.resolve([]);
  }
};
`;

console.log("Step 1: Bundling dockerfile-language-server-nodejs...");

let stubbed = false;
const result = await Bun.build({
  entrypoints: [path.join(serverDir, "lib/server.js")],
  target: "bun",
  outdir: INTERMEDIATE,
  plugins: [
    {
      name: "offline-registry-client",
      setup(build) {
        build.onLoad({ filter: /dockerRegistryClient\.js$/ }, async (args) => {
          const source = await Bun.file(args.path).text();
          if (!source.includes("DockerRegistryClient.prototype.getTags")) {
            throw new Error(`${args.path} no longer defines getTags: update the offline stub`);
          }
          stubbed = true;
          return { contents: OFFLINE_REGISTRY_CLIENT, loader: "js" };
        });
      },
    },
  ],
});

if (!result.success) {
  console.error("Bundle step failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
// A service that moved or renamed its registry client would otherwise ship it unpatched.
if (!stubbed)
  throw new Error("The bundle never loaded dockerRegistryClient.js: update the offline stub");

console.log("Step 1 complete.");

console.log("Step 2: Compiling to standalone binary...");

const outfile = path.join(OUTDIR, "docker-langserver");

const compile = Bun.spawn(
  ["bun", "build", path.join(INTERMEDIATE, "server.js"), "--compile", "--outfile", outfile],
  { stdout: "inherit", stderr: "inherit" },
);
const exitCode = await compile.exited;
if (exitCode !== 0) {
  console.error("Compile step failed");
  process.exit(1);
}

console.log(`Built: ${outfile}`);
