/**
 * Pins the SHA256 of every file a pinned download (pinned-download.ts) names for its version: a
 * language-server manifest or go-toolchain.json. Renovate runs it after bumping a version
 * (renovate.json `postUpgradeTasks`); after changing a version by hand, run
 *
 *   pnpm -C packages/loxel run pin-hashes <manifest name | go-toolchain | path to its .json>...
 *
 * Digests come from what the publisher states, with no download: the GitHub API's `digest` of a
 * release asset, go.dev's release list and Eclipse's `.sha256` next to a JDT LS archive, whose name
 * (it carries a build timestamp) comes from the release's `latest.txt`. Any other file is downloaded
 * and hashed. `GITHUB_TOKEN`, when set, authenticates the GitHub API calls.
 *
 * Imports nothing outside the runtime, so it runs in Renovate's checkout with no `pnpm install`.
 */

import { createHash } from "node:crypto";
import path from "node:path";

import {
  type PinnedDownload,
  SHA256_HEX,
  downloadUrl,
  isRecord,
  readPinnedDownload,
} from "./pinned-download";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const GITHUB_ASSET =
  /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/;
const GO_ARCHIVE = /^https:\/\/go\.dev\/dl\/([^/?]+)$/;
const ECLIPSE_HOST = "https://download.eclipse.org/";

async function fetchOk(fetchFn: Fetch, url: string, init?: RequestInit): Promise<Response> {
  const res = await fetchFn(url, init);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res;
}

function checkedDigest(digest: string, source: string): string {
  if (!SHA256_HEX.test(digest)) throw new Error(`${source} gave no SHA256 (${digest})`);
  return digest;
}

async function downloadAndHash(fetchFn: Fetch, url: string): Promise<string> {
  const bytes = await (await fetchOk(fetchFn, url)).arrayBuffer();
  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
}

/** The digest of each asset of a GitHub release, by name; null where GitHub states none. */
async function githubReleaseDigests(
  fetchFn: Fetch,
  repo: string,
  tag: string,
): Promise<Map<string, string | null>> {
  const token = process.env.GITHUB_TOKEN;
  const api = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const release: unknown = await (
    await fetchOk(fetchFn, api, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
  ).json();
  if (!isRecord(release) || !Array.isArray(release.assets)) throw new Error(`${api}: no assets`);
  const digests = new Map<string, string | null>();
  for (const asset of release.assets) {
    if (!isRecord(asset) || typeof asset.name !== "string") continue;
    const { digest } = asset;
    const stated = typeof digest === "string" && digest.startsWith("sha256:");
    digests.set(asset.name, stated ? digest.slice("sha256:".length) : null);
  }
  return digests;
}

/** go.dev's SHA256 of each Go release archive, by file name. */
async function goArchiveDigests(fetchFn: Fetch): Promise<Map<string, string>> {
  const url = "https://go.dev/dl/?mode=json&include=all";
  const releases: unknown = await (await fetchOk(fetchFn, url)).json();
  if (!Array.isArray(releases)) throw new Error(`${url}: not a list of releases`);
  const digests = new Map<string, string>();
  for (const release of releases) {
    if (!isRecord(release) || !Array.isArray(release.files)) continue;
    for (const file of release.files) {
      if (isRecord(file) && typeof file.filename === "string" && typeof file.sha256 === "string") {
        digests.set(file.filename, file.sha256);
      }
    }
  }
  return digests;
}

/**
 * The targets to pin for the version: the ones already pinned, except for an Eclipse download whose
 * target is the whole file name, which is the archive the release's `latest.txt` names.
 */
async function targetsFor(fetchFn: Fetch, pinned: PinnedDownload): Promise<string[]> {
  if (!pinned.download.startsWith(ECLIPSE_HOST) || !pinned.download.endsWith("/{target}")) {
    return Object.keys(pinned.sha256);
  }
  const latest = await (await fetchOk(fetchFn, downloadUrl(pinned, "latest.txt"))).text();
  return [latest.trim()];
}

/** The SHA256 of each target's file for `pinned.version`, by target. */
export async function resolvePins(
  pinned: PinnedDownload,
  fetchFn: Fetch = fetch,
): Promise<Record<string, string>> {
  const releases = new Map<string, Promise<Map<string, string | null>>>();
  let goDigests: Promise<Map<string, string>> | undefined;
  const pins: Record<string, string> = {};
  for (const target of await targetsFor(fetchFn, pinned)) {
    const url = downloadUrl(pinned, target);
    const github = GITHUB_ASSET.exec(url);
    const go = GO_ARCHIVE.exec(url);
    if (github) {
      const [, repo = "", tag = "", name = ""] = github;
      const key = `${repo}@${tag}`;
      const release = releases.get(key) ?? githubReleaseDigests(fetchFn, repo, tag);
      releases.set(key, release);
      const digests = await release;
      if (!digests.has(name)) throw new Error(`${repo} ${tag} has no asset ${name}`);
      pins[target] = checkedDigest(digests.get(name) ?? (await downloadAndHash(fetchFn, url)), url);
    } else if (go) {
      goDigests ??= goArchiveDigests(fetchFn);
      const digest = (await goDigests).get(go[1] ?? "");
      if (!digest) throw new Error(`go.dev lists no archive ${go[1]}`);
      pins[target] = checkedDigest(digest, url);
    } else if (url.startsWith(ECLIPSE_HOST)) {
      const stated = await (await fetchOk(fetchFn, `${url}.sha256`)).text();
      pins[target] = checkedDigest(stated.trim().split(/\s+/)[0] ?? "", `${url}.sha256`);
    } else {
      pins[target] = checkedDigest(await downloadAndHash(fetchFn, url), url);
    }
  }
  return pins;
}

// The repository's formatter (.oxfmtrc.jsonc): an object that fits in this width goes on one line.
const PRINT_WIDTH = 100;

/**
 * `json` (a pinned download's file) with its `"sha256"` object replaced by `pins`, laid out as the
 * repository's formatter would: on one line when that fits, else one entry per line.
 */
export function withPins(json: string, pins: Record<string, string>): string {
  const block = /^([ \t]*)"sha256": \{[^}]*\}(.*)$/m;
  const match = block.exec(json);
  if (!match) throw new Error('no "sha256" object to replace');
  const [, indent = "", rest = ""] = match;
  const entries = Object.entries(pins).map(
    ([target, digest]) => `${JSON.stringify(target)}: "${digest}"`,
  );
  const oneLine = `${indent}"sha256": { ${entries.join(", ")} }`;
  const replaced =
    (oneLine + rest).length <= PRINT_WIDTH
      ? oneLine
      : `${indent}"sha256": {\n${entries.map((entry) => `${indent}  ${entry}`).join(",\n")}\n${indent}}`;
  return json.replace(block, () => replaced + rest);
}

/** The file an argument names: a path to a .json, `go-toolchain`, or a manifest name. */
function fileFor(arg: string): string {
  if (arg.endsWith(".json")) return path.resolve(arg);
  if (arg === "go-toolchain") return path.join(import.meta.dir, "go-toolchain.json");
  return path.join(import.meta.dir, "language-servers", `${arg}.json`);
}

async function pin(file: string): Promise<void> {
  const text = await Bun.file(file).text();
  const json: unknown = JSON.parse(text);
  if (!isRecord(json) || json.download === undefined) {
    console.log(`${path.basename(file)} pins no download, nothing to do`);
    return;
  }
  const pinned = readPinnedDownload(file, json);
  const updated = withPins(text, await resolvePins(pinned));
  if (updated === text) {
    console.log(`${path.basename(file)}: ${pinned.version} already pinned`);
    return;
  }
  await Bun.write(file, updated);
  console.log(`${path.basename(file)}: pinned ${pinned.version}`);
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length === 0) {
    throw new Error("Usage: pin-hashes.ts <manifest name | go-toolchain | path to .json>...");
  }
  for (const arg of args) await pin(fileFor(arg));
}
