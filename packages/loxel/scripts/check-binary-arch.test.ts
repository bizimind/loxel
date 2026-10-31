import { describe, expect, test } from "bun:test";

import { binaryPlatforms } from "./check-binary-arch";

const X64 = 0x01_00_00_07;
const ARM64 = 0x01_00_00_0c;

function bytes(write: (view: DataView) => void, length = 64): Uint8Array {
  const buffer = new ArrayBuffer(length);
  write(new DataView(buffer));
  return new Uint8Array(buffer);
}

function thinMachO(cpuType: number): Uint8Array {
  return bytes((view) => {
    view.setUint32(0, 0xcf_fa_ed_fe);
    view.setUint32(4, cpuType, true);
  });
}

function universal(magic: number, entrySize: number, cpuTypes: number[]): Uint8Array {
  return bytes((view) => {
    view.setUint32(0, magic);
    view.setUint32(4, cpuTypes.length);
    for (const [slice, cpuType] of cpuTypes.entries()) {
      view.setUint32(8 + slice * entrySize, cpuType);
    }
  }, 128);
}

function elf(machine: number): Uint8Array {
  return bytes((view) => {
    view.setUint32(0, 0x7f_45_4c_46);
    view.setUint16(18, machine, true);
  });
}

describe("binaryPlatforms", () => {
  test("reads a thin Mach-O's architecture", () => {
    expect(binaryPlatforms(thinMachO(X64))).toEqual(["darwin-x64"]);
    expect(binaryPlatforms(thinMachO(ARM64))).toEqual(["darwin-arm64"]);
  });

  test("lists every slice of a universal binary, in either table format", () => {
    expect(binaryPlatforms(universal(0xca_fe_ba_be, 20, [X64, ARM64]))).toEqual([
      "darwin-x64",
      "darwin-arm64",
    ]);
    expect(binaryPlatforms(universal(0xca_fe_ba_bf, 32, [ARM64, X64]))).toEqual([
      "darwin-arm64",
      "darwin-x64",
    ]);
  });

  test("reads an ELF's architecture", () => {
    expect(binaryPlatforms(elf(62))).toEqual(["linux-x64"]);
    expect(binaryPlatforms(elf(183))).toEqual(["linux-arm64"]);
  });

  test("names an architecture it doesn't know, so it can never match a target", () => {
    expect(binaryPlatforms(thinMachO(0x07))).toEqual(["darwin-cpu7"]);
    expect(binaryPlatforms(elf(40))).toEqual(["linux-machine40"]);
  });

  test("ignores a Java class file, which shares the universal binary's magic", () => {
    const classFile = bytes((view) => {
      view.setUint32(0, 0xca_fe_ba_be);
      view.setUint32(4, 65);
    });
    expect(binaryPlatforms(classFile)).toBeNull();
  });

  test("ignores a file too short to hold the slice table it claims", () => {
    const truncated = bytes((view) => {
      view.setUint32(0, 0xca_fe_ba_be);
      view.setUint32(4, 2);
    }, 8);
    expect(binaryPlatforms(truncated)).toBeNull();
  });

  test("ignores everything else", () => {
    expect(binaryPlatforms(new TextEncoder().encode("#!/bin/sh\necho hello\n"))).toBeNull();
    expect(binaryPlatforms(new Uint8Array(0))).toBeNull();
    expect(binaryPlatforms(new Uint8Array([0xcf, 0xfa]))).toBeNull();
  });
});
