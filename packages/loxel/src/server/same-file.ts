import { statSync } from "node:fs";

/**
 * Whether two paths name the same file, following symlinks; false when either cannot be read.
 *
 * Compare by identity rather than by `realpath` where a file has several hard links: macOS asks the
 * kernel for a path of the file, which can be any of its names. Apple's developer-tool stubs in
 * `/usr/bin` are one file with dozens of names, so `realpath("/usr/bin/clangd")` returns
 * `/usr/bin/git` whenever git ran last.
 */
export function isSameFileSync(a: string, b: string): boolean {
  try {
    const [infoA, infoB] = [statSync(a), statSync(b)];
    return infoA.dev === infoB.dev && infoA.ino === infoB.ino;
  } catch {
    return false;
  }
}
