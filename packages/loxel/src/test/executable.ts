/**
 * Stand-in executables for tests, written as hard links into a store of scripts that persists
 * between runs.
 *
 * macOS checks every new executable file the first time it runs, one at a time for the whole
 * system: a few hundred milliseconds each, which the server tests, writing hundreds of stand-in
 * tools, spent most of their time waiting on. The check is per file, and a hard link is the same
 * file, so a script that ran once runs at once from any new path. The path stays the test's own,
 * as `realpath` sees it, so where a tool lives (in a repository, beside a toolchain) still means
 * what it means to the code under test. A store entry is shared by every path linked to it, which
 * makes it read-only: change a stand-in by writing it again, never in place or with `chmod`. One
 * that was changed anyway, through a link, is replaced the next time it is asked for.
 *
 * Only a script whose content repeats gains: keep a test's paths out of it, reading them from
 * `$0` or from what the code under test passes it. `$0` is the path the tool was run by, so a run
 * through a symlink names the link: resolve it before comparing it with the file. A script naming a temporary path is a test's
 * own and never repeats, so it is written as a new file and kept out of the store.
 */
import { chmod, link, lstat, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const TEMP = tmpdir();
const READ_ONLY_EXECUTABLE = 0o555;
const uid = process.getuid?.() ?? 0;
/** One per user: another user's entries are never linked, let alone run. */
const STORE = join(TEMP, `loxel-test-executables-${uid}`);

/**
 * Write `script` as an executable at `file`, creating its directory. Two files with the same name and
 * content share a store entry; one with another name gets its own, so tools the code under test
 * tells apart by inode (a rustup proxy is a hard link to rustup) stay apart. With `newFile`, the
 * file is a new one of its own, for a test that replaces a tool with an identical one, as a
 * reinstall does, and expects the code to notice.
 */
export async function writeExecutable(
  file: string,
  script = "#!/bin/sh\n",
  { newFile = false } = {},
): Promise<string> {
  await mkdir(dirname(file), { recursive: true });
  await rm(file, { force: true });
  if (newFile || script.includes(TEMP) || !(await linkFromStore(file, script))) {
    await writeFile(file, script, { mode: 0o755 });
  }
  return file;
}

/**
 * Link `file` to the store's entry for `script`, adding the entry when it is missing or was changed.
 * False when `file` is on another file system, where no link can reach.
 */
async function linkFromStore(file: string, script: string): Promise<boolean> {
  const name = basename(file);
  const entry = join(await openStore(), `${Bun.hash(`${name}\0${script}`).toString(16)}-${name}`);
  const linked = await tryLink(entry, file);
  if (linked === "other-file-system") return false;
  if (linked === "linked") {
    if (await isIntact(file, script)) return true;
    await rm(file);
  }
  await addToStore(entry, script);
  await link(entry, file);
  return true;
}

async function tryLink(
  entry: string,
  file: string,
): Promise<"linked" | "missing" | "other-file-system"> {
  try {
    await link(entry, file);
    return "linked";
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return "missing";
    if (code === "EXDEV") return "other-file-system";
    throw error;
  }
}

/** Whether the entry `file` is linked to still has the mode and content it was stored with. */
async function isIntact(file: string, script: string): Promise<boolean> {
  const { mode } = await stat(file);
  return (mode & 0o777) === READ_ONLY_EXECUTABLE && (await Bun.file(file).text()) === script;
}

let opened: Promise<string> | undefined;

/** The store, made private to this user, refusing one anyone else could have put entries in. */
function openStore(): Promise<string> {
  opened ??= (async () => {
    await mkdir(STORE, { recursive: true, mode: 0o700 });
    const info = await lstat(STORE);
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) {
      throw new Error(
        `${STORE} is not a directory only this user can open; remove it to run tests`,
      );
    }
    return STORE;
  })();
  return opened;
}

/** Write the entry under a name of its own and move it in, so no one links a half-written file. */
async function addToStore(entry: string, script: string): Promise<void> {
  const partial = `${entry}.${process.pid}.${crypto.randomUUID()}`;
  await writeFile(partial, script);
  await chmod(partial, READ_ONLY_EXECUTABLE);
  await rename(partial, entry);
}
