/**
 * Fails a release whose output holds a binary that can't run on its target platform:
 *
 *   bun scripts/check-binary-arch.ts <platform> <dir...>
 *
 * Everything under the directories is read, so a new language server is covered without a list to
 * edit. Files are recognised by their header rather than their name or mode, and a universal binary
 * passes if it has a slice for the target.
 */

import { readdirSync } from "node:fs";
import path from "node:path";

const MACH_O_CPUS = new Map([
  [0x01_00_00_07, "x64"],
  [0x01_00_00_0c, "arm64"],
]);
const ELF_MACHINES = new Map([
  [62, "x64"],
  [183, "arm64"],
]);

/** Far more than any universal binary has; Java class files share the magic but read as 45+. */
const MAX_FAT_SLICES = 32;
/** Enough for a universal binary's whole slice table. */
const HEADER_BYTES = 4096;

function machOPlatform(cpuType: number): string {
  return `darwin-${MACH_O_CPUS.get(cpuType) ?? `cpu${cpuType.toString(16)}`}`;
}

/** The platforms a file runs on, or null when it isn't a Mach-O or ELF binary. */
export function binaryPlatforms(header: Uint8Array): string[] | null {
  if (header.length < 8) return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const magic = view.getUint32(0);

  // CF FA ED FE and CE FA ED FE: thin 64-bit and 32-bit Mach-O, little-endian.
  if (magic === 0xcf_fa_ed_fe || magic === 0xce_fa_ed_fe) {
    return [machOPlatform(view.getUint32(4, true))];
  }

  // CA FE BA BE and CA FE BA BF: universal binaries, big-endian, with 32- and 64-bit slice tables.
  if (magic === 0xca_fe_ba_be || magic === 0xca_fe_ba_bf) {
    const slices = view.getUint32(4);
    if (slices === 0 || slices >= MAX_FAT_SLICES) return null;
    const entrySize = magic === 0xca_fe_ba_be ? 20 : 32;
    if (8 + slices * entrySize > header.length) return null;
    return Array.from({ length: slices }, (_, slice) =>
      machOPlatform(view.getUint32(8 + slice * entrySize)),
    );
  }

  if (magic === 0x7f_45_4c_46 && header.length >= 20) {
    const machine = view.getUint16(18, true);
    return [`linux-${ELF_MACHINES.get(machine) ?? `machine${machine}`}`];
  }
  return null;
}

/** Every file under `dir`. Symlinks aren't followed: an app's frameworks link back into themselves. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(entryPath);
    return entry.isFile() ? [entryPath] : [];
  });
}

async function main([target, ...dirs]: string[]): Promise<void> {
  if (!target || dirs.length === 0) {
    throw new Error("Usage: check-binary-arch.ts <platform> <dir...>");
  }

  let checked = 0;
  const wrong: string[] = [];
  for (const file of dirs.flatMap(filesUnder)) {
    const header = await Bun.file(file).slice(0, HEADER_BYTES).bytes();
    const platforms = binaryPlatforms(header);
    if (!platforms) continue;
    checked += 1;
    console.log(`${platforms.join(", ")}\t${file}`);
    if (!platforms.includes(target)) wrong.push(`${file}: ${platforms.join(", ")}`);
  }

  // Finding nothing means the path is wrong, not that the output is right.
  if (checked === 0) throw new Error(`No binaries found under ${dirs.join(", ")}`);
  if (wrong.length > 0) {
    throw new Error(
      `${wrong.length} of ${checked} binaries aren't ${target}:\n${wrong.join("\n")}`,
    );
  }
  console.log(`All ${checked} binaries run on ${target}`);
}

if (import.meta.main) await main(Bun.argv.slice(2));
