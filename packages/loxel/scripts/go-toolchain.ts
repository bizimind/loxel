/**
 * The Go toolchain language servers built from source compile with, so those builds need no Go
 * install. It is pinned by SHA256 and downloaded into `build/`.
 */

import path from "node:path";

import { BUILD_DIR, downloadReleaseBinary } from "./download-release-binary";

export const GO_VERSION = "1.27.3";

/** Pinned SHA256 digests from https://go.dev/dl/?mode=json */
const GO_SHA256: Record<string, string> = {
  "darwin-amd64": "b6f8e931e4ab497fcde6da8ae4499a58f9d258e55c8a80824a516eae5950a750",
  "darwin-arm64": "dd3908cf20959d798c1e06ebe5b72213f0505ce01373b40ce3110975a6cd99c2",
  "linux-amd64": "65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40",
  "linux-arm64": "a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49",
  "windows-amd64": "f26081f438319757f8a1b46d7d0b2c5ec7583d4038e485e0aa725cfde7885fff",
  "windows-arm64": "c507872ff21f8a7cd3c1c217b059c6f7271a4a9d8e692810ef9dd3e1f601197c",
};

function goPlatform(): string {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch;
  const os = process.platform === "win32" ? "windows" : process.platform;
  return `${os}-${arch}`;
}

const ext = process.platform === "win32" ? ".exe" : "";

export interface GoToolchain {
  goRoot: string;
  /** The `go` binary. */
  go: string;
}

/** The pinned toolchain, downloading it unless it is already in `build/`. */
export async function ensureGoToolchain(): Promise<GoToolchain> {
  const platform = goPlatform();
  const sha256 = GO_SHA256[platform];
  if (!sha256) throw new Error(`No pinned Go toolchain for platform ${platform}`);

  const goRoot = path.join(BUILD_DIR, `go-${GO_VERSION}`);
  await downloadReleaseBinary({
    name: "go",
    url: `https://go.dev/dl/go${GO_VERSION}.${platform}${ext ? ".zip" : ".tar.gz"}`,
    sha256,
    member: "go",
    outBinary: goRoot,
  });
  return { goRoot, go: path.join(goRoot, "bin", `go${ext}`) };
}
