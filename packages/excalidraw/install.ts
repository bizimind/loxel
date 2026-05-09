#!/usr/bin/env bun
/**
 * Build and install the excalidraw CLI globally.
 *
 * 1. Compiles to dist/excalidraw (standalone binary via build.ts)
 * 2. Copies binary to ~/.local/bin/excalidraw
 * 3. Ad-hoc codesigns (required on macOS or the binary gets SIGKILL'd)
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

const root = import.meta.dirname;
const binDir = resolve(homedir(), ".local/bin");
const binPath = resolve(binDir, "excalidraw");

// Step 1: Build
await import("./build.ts");

// Step 2: Copy binary
await Bun.$`mkdir -p ${binDir}`;
await Bun.$`cp ${resolve(root, "dist/excalidraw")} ${binPath}`.quiet();

// Step 3: Codesign (macOS only — required or the binary gets SIGKILL'd)
if (process.platform === "darwin") {
  await Bun.$`codesign -s - ${binPath}`.quiet();
}

console.log(`Installed excalidraw to ${binPath}`);
