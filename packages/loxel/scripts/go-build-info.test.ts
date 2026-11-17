import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { findGoBinaries, readGoBuildInfo } from "./go-build-info";

function uvarint(n: number): number[] {
  const bytes: number[] = [];
  let rest = n;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  return [...bytes, rest];
}

/** A Mach-O-looking file with Go 1.18+ inline build info, as the linker lays it out. */
function goBinary(goVersion: string, modInfo: string): Uint8Array {
  const text = (value: string) => [...Buffer.from(value, "utf8")];
  const sentinel = new Array<number>(16).fill(0x30);
  const modBytes = [...sentinel, ...text(modInfo), ...sentinel];
  return Uint8Array.from([
    0xcf,
    0xfa,
    0xed,
    0xfe,
    0,
    0,
    0,
    0,
    ...Buffer.from("\xff Go buildinf:", "latin1"),
    8,
    0x2,
    ...new Array<number>(16).fill(0),
    ...uvarint(goVersion.length),
    ...text(goVersion),
    ...uvarint(modBytes.length),
    ...modBytes,
  ]);
}

const MOD_INFO = [
  "path\texample.com/x/cmd/x",
  "mod\texample.com/x\tv1.2.3\th1:abc=",
  "dep\tgolang.org/x/text\tv0.25.0\th1:def=",
  "dep\texample.com/forked\tv1.0.0\th1:ghi=",
  "=>\texample.com/fork\tv1.0.1\th1:jkl=",
  "dep\texample.com/local\tv0.0.0",
  "=>\t../local\t",
  "build\t-trimpath=true",
  "",
].join("\n");

describe("readGoBuildInfo", () => {
  test("reads the Go version, main module and dependencies, replacements applied", () => {
    expect(readGoBuildInfo(goBinary("go1.26.4", MOD_INFO))).toEqual({
      goVersion: "go1.26.4",
      main: { path: "example.com/x", version: "v1.2.3" },
      deps: [
        { path: "golang.org/x/text", version: "v0.25.0" },
        { path: "example.com/fork", version: "v1.0.1" },
      ],
    });
  });

  test("is undefined for a file that is not a Go binary", () => {
    expect(readGoBuildInfo(Buffer.from("not a go binary"))).toBeUndefined();
  });
});

describe("findGoBinaries", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "go-build-info-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("finds executable Go binaries in subdirectories, and nothing else", async () => {
    mkdirSync(path.join(dir, "lib"));
    writeFileSync(path.join(dir, "lib", "tool"), goBinary("go1.27.4", MOD_INFO));
    chmodSync(path.join(dir, "lib", "tool"), 0o755);
    // Not executable, so not shipped as a program.
    writeFileSync(path.join(dir, "data.bin"), goBinary("go1.27.4", MOD_INFO));
    writeFileSync(path.join(dir, "script.sh"), "#!/bin/sh\n");
    chmodSync(path.join(dir, "script.sh"), 0o755);

    const found = await findGoBinaries(dir);
    expect(found.map(({ file, info }) => [file, info.goVersion])).toEqual([
      [path.join("lib", "tool"), "go1.27.4"],
    ]);
  });
});
