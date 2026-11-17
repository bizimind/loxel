/**
 * Reads the build info the Go linker embeds in every binary, what `go version -m <binary>` prints:
 * the Go version and the modules compiled in. It is read from the file itself, so no Go toolchain
 * is needed. Only the inline format of Go 1.18 and later is supported; an older binary throws.
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/** `\xff Go buildinf:`, which starts the 32-byte header of the `.go.buildinfo` section. */
const MAGIC = Buffer.from("\xff Go buildinf:", "latin1");
const HEADER_SIZE = 32;
/** Header flag: the version and module strings follow the header (Go 1.18+). */
const FLAG_INLINE = 0x2;
/** The module info string is wrapped in a 16-byte sentinel on each side. */
const SENTINEL_SIZE = 16;

/** Mach-O (64-bit, either byte order, universal), ELF and PE executables. */
const EXECUTABLE_MAGICS = ["cffaedfe", "feedfacf", "cafebabe", "7f454c46"];

export interface GoModule {
  path: string;
  version: string;
}

export interface GoBuildInfo {
  /** As the binary records it, e.g. `go1.26.4`. */
  goVersion: string;
  /** The main module; `(devel)` when built from a checkout rather than a module version. */
  main?: GoModule;
  /** The modules compiled in, replacements applied, without those replaced by a local path. */
  deps: GoModule[];
}

/** The build info of a Go binary, or undefined when `data` is not one. */
export function readGoBuildInfo(data: Uint8Array): GoBuildInfo | undefined {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const start = buf.indexOf(MAGIC);
  if (start < 0) return undefined;
  if (((buf[start + 15] ?? 0) & FLAG_INLINE) === 0) {
    throw new Error("Go build info from before Go 1.18 is not supported");
  }
  let pos = start + HEADER_SIZE;
  // A uvarint length, then that many bytes.
  const readString = (): Buffer => {
    let length = 0;
    let shift = 0;
    let byte = 0x80;
    while (byte & 0x80) {
      if (pos >= buf.length) throw new Error("Truncated Go build info");
      byte = buf[pos++] ?? 0;
      length += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (pos + length > buf.length) throw new Error("Truncated Go build info");
    const value = buf.subarray(pos, pos + length);
    pos += length;
    return value;
  };
  const goVersion = readString().toString("utf8");
  let modInfo = readString();
  if (modInfo.length > 2 * SENTINEL_SIZE) {
    modInfo = modInfo.subarray(SENTINEL_SIZE, modInfo.length - SENTINEL_SIZE);
  }
  return { goVersion, ...parseModInfo(modInfo.toString("utf8")) };
}

/** The `mod`, `dep` and `=>` (replacement) lines of `go version -m` output. */
function parseModInfo(text: string): Omit<GoBuildInfo, "goVersion"> {
  let main: GoModule | undefined;
  const deps: (GoModule | undefined)[] = [];
  for (const line of text.split("\n")) {
    const [kind, modPath = "", version = ""] = line.split("\t");
    if (kind === "mod") main = { path: modPath, version };
    if (kind === "dep") deps.push({ path: modPath, version });
    // Replaces the dep before it; a local directory (no version) is not a module anyone can look up.
    if (kind === "=>" && deps.length > 0) {
      deps[deps.length - 1] = version ? { path: modPath, version } : undefined;
    }
  }
  return { main, deps: deps.filter((dep) => dep !== undefined) };
}

/** Each Go binary under `dir`, recursively, with its path relative to `dir`. */
export async function findGoBinaries(
  dir: string,
): Promise<Array<{ file: string; info: GoBuildInfo }>> {
  const found: Array<{ file: string; info: GoBuildInfo }> = [];
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).toSorted();
  for (const file of files) {
    const full = path.join(dir, file);
    const stat = statSync(full);
    if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
    const head = Buffer.from(await Bun.file(full).slice(0, 4).bytes()).toString("hex");
    if (!EXECUTABLE_MAGICS.includes(head) && !head.startsWith("4d5a")) continue;
    const info = readGoBuildInfo(await Bun.file(full).bytes());
    if (info) found.push({ file, info });
  }
  return found;
}
