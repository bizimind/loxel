import { randomUUID } from "node:crypto";
import { cp, mkdir, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { $ } from "bun";

// Resolve the real tmpdir to handle macOS /tmp → /private/tmp symlink
let resolvedTmpDir: string | undefined;
async function getTmpPrefix(): Promise<string> {
  resolvedTmpDir ??= await realpath(tmpdir());
  return `${resolvedTmpDir}/loxel-test-`;
}

function assertTempPath(repoPath: string): void {
  if (!resolvedTmpDir || !repoPath.startsWith(`${resolvedTmpDir}/loxel-test-`)) {
    throw new Error(`Refusing to run git command on non-temp path: ${repoPath}`);
  }
}

export interface TempRepo {
  path: string;
  copy(): Promise<TempRepo>;
  cleanup(): Promise<void>;
}

function makeTempRepo(repoPath: string): TempRepo {
  return {
    path: repoPath,
    async copy() {
      assertTempPath(repoPath);
      const prefix = await getTmpPrefix();
      const copyDir = `${prefix}${randomUUID()}`;
      await cp(repoPath, copyDir, { recursive: true });
      return makeTempRepo(copyDir);
    },
    async cleanup() {
      assertTempPath(repoPath);
      await rm(repoPath, { recursive: true, force: true });
    },
  };
}

export async function createRepo(): Promise<TempRepo> {
  const prefix = await getTmpPrefix();
  const dir = `${prefix}${randomUUID()}`;
  await mkdir(dir, { recursive: true });
  await $`git init -b main ${dir}`.quiet();
  await $`git -C ${dir} config user.email "test@loxel.dev"`.quiet();
  await $`git -C ${dir} config user.name "Test"`.quiet();
  return makeTempRepo(dir);
}

export async function createBareRepo(): Promise<TempRepo> {
  const prefix = await getTmpPrefix();
  const dir = `${prefix}${randomUUID()}`;
  await mkdir(dir, { recursive: true });
  await $`git init --bare ${dir}`.quiet();
  return makeTempRepo(dir);
}

export async function commit(
  repoPath: string,
  message: string,
  files?: Record<string, string>,
): Promise<string> {
  assertTempPath(repoPath);
  if (files) {
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(repoPath, name);
      const dir = path.dirname(filePath);
      await mkdir(dir, { recursive: true });
      await Bun.write(filePath, content);
    }
    await $`git -C ${repoPath} add -A`.quiet();
  }
  await $`git -C ${repoPath} commit --allow-empty -m ${message}`.quiet();
  return (await $`git -C ${repoPath} rev-parse HEAD`.text()).trim();
}

export async function branch(repoPath: string, name: string): Promise<void> {
  assertTempPath(repoPath);
  await $`git -C ${repoPath} checkout -b ${name}`.quiet();
}

export async function checkoutBranch(repoPath: string, name: string): Promise<void> {
  assertTempPath(repoPath);
  await $`git -C ${repoPath} checkout ${name}`.quiet();
}

export async function merge(
  repoPath: string,
  branchName: string,
  message?: string,
): Promise<string> {
  assertTempPath(repoPath);
  const msg = message ?? `Merge ${branchName}`;
  await $`git -C ${repoPath} merge --no-ff ${branchName} -m ${msg}`.quiet();
  return (await $`git -C ${repoPath} rev-parse HEAD`.text()).trim();
}

export async function tag(repoPath: string, name: string): Promise<void> {
  assertTempPath(repoPath);
  await $`git -C ${repoPath} tag ${name}`.quiet();
}

export async function writeFile(
  repoPath: string,
  filePath: string,
  content: string,
): Promise<void> {
  assertTempPath(repoPath);
  const fullPath = path.join(repoPath, filePath);
  const dir = path.dirname(fullPath);
  await mkdir(dir, { recursive: true });
  await Bun.write(fullPath, content);
}

export async function stageFile(repoPath: string, filePath: string): Promise<void> {
  assertTempPath(repoPath);
  await $`git -C ${repoPath} add -- ${filePath}`.quiet();
}

export async function deleteFile(repoPath: string, filePath: string): Promise<void> {
  assertTempPath(repoPath);
  await unlink(path.join(repoPath, filePath));
}

export async function renameFile(repoPath: string, from: string, to: string): Promise<void> {
  assertTempPath(repoPath);
  await $`git -C ${repoPath} mv ${from} ${to}`.quiet();
}
