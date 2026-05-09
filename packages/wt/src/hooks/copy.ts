import { wrapError, type OutputContext } from "@bizimind/cli-common";
import { Glob } from "bun";
import { mkdir, cp } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, isAbsolute, relative, basename, resolve, sep } from "node:path";

import type { FileItem, CopyItem, TemplateFileItem, InlineTemplateItem } from "../config/schema.ts";

import { processTemplate } from "./template.ts";

/**
 * Options for file processing.
 */
interface ProcessFilesOptions {
  /** Environment variables for template substitution */
  env?: Record<string, string>;
  /** Output context for logging */
  ctx?: OutputContext;
}

// Type guards for FileItem variants
function isString(item: FileItem): item is string {
  return typeof item === "string";
}

function isCopyItem(item: FileItem): item is CopyItem {
  return typeof item === "object" && "source" in item;
}

function isTemplateFileItem(item: FileItem): item is TemplateFileItem {
  return typeof item === "object" && "template_file" in item;
}

function isInlineTemplateItem(item: FileItem): item is InlineTemplateItem {
  return typeof item === "object" && "inline_template" in item;
}

/**
 * Validate that a destination path doesn't escape the worktree directory.
 * Prevents path traversal attacks via malicious dest values like "../../.bashrc".
 */
function validateDestPath(destPath: string, destDir: string, configDest: string): void {
  const normalizedDest = resolve(destPath);
  const normalizedDir = resolve(destDir);

  if (!normalizedDest.startsWith(normalizedDir + sep) && normalizedDest !== normalizedDir) {
    throw new Error(`Destination path escapes worktree directory: ${configDest}`);
  }
}

/**
 * Compute the destination path for a matched file.
 */
function computeDestPath(sourcePath: string, dest: string | undefined, destDir: string): string {
  if (!dest) {
    // No dest: mirror source structure
    return join(destDir, sourcePath);
  }

  if (dest.endsWith("/")) {
    // Dest is directory: place inside preserving relative path
    return join(destDir, dest, sourcePath);
  }

  // Dest is explicit file path
  return join(destDir, dest);
}

/**
 * Process a simple string pattern (glob copy).
 */
async function processStringItem(
  pattern: string,
  sourceDir: string,
  destDir: string,
  options: ProcessFilesOptions,
): Promise<void> {
  const glob = new Glob(pattern);

  try {
    for await (const match of glob.scan({ cwd: sourceDir, absolute: false })) {
      const sourcePath = join(sourceDir, match);
      const destPath = join(destDir, match);

      const sourceFile = Bun.file(sourcePath);
      const stat = await sourceFile.stat().catch(() => null);

      if (!stat) continue;

      await mkdir(dirname(destPath), { recursive: true });

      if (stat.isDirectory()) {
        await cp(sourcePath, destPath, { recursive: true });
        options.ctx?.log(`  Copied: ${match}/`);
      } else {
        await cp(sourcePath, destPath);
        options.ctx?.log(`  Copied: ${match}`);
      }
    }
  } catch (err) {
    throw wrapError(`Failed to copy pattern '${pattern}'`, err);
  }
}

/**
 * Process a copy item (with optional custom destination).
 */
async function processCopyItem(
  item: CopyItem,
  sourceDir: string,
  destDir: string,
  options: ProcessFilesOptions,
): Promise<void> {
  const glob = new Glob(item.source);

  try {
    for await (const match of glob.scan({ cwd: sourceDir, absolute: false })) {
      const sourcePath = join(sourceDir, match);
      const destPath = computeDestPath(match, item.dest, destDir);

      // Validate dest doesn't escape worktree (only needed when custom dest is provided)
      if (item.dest) {
        validateDestPath(destPath, destDir, item.dest);
      }

      const sourceFile = Bun.file(sourcePath);
      const stat = await sourceFile.stat().catch(() => null);

      if (!stat) continue;

      await mkdir(dirname(destPath), { recursive: true });

      if (stat.isDirectory()) {
        await cp(sourcePath, destPath, { recursive: true });
        options.ctx?.log(`  Copied: ${match}/`);
      } else {
        await cp(sourcePath, destPath);
        const destRelative = relative(destDir, destPath);
        if (destRelative !== match) {
          options.ctx?.log(`  Copied: ${match} -> ${destRelative}`);
        } else {
          options.ctx?.log(`  Copied: ${match}`);
        }
      }
    }
  } catch (err) {
    throw wrapError(`Failed to copy pattern '${item.source}'`, err);
  }
}

/**
 * Process a template file item.
 */
async function processTemplateFileItem(
  item: TemplateFileItem,
  sourceDir: string,
  destDir: string,
  options: ProcessFilesOptions,
): Promise<void> {
  const sourcePath = join(sourceDir, item.template_file);
  const sourceFile = Bun.file(sourcePath);

  if (!(await sourceFile.exists())) {
    throw new Error(`Template file not found: ${item.template_file}`);
  }

  // Compute destination: use dest if provided, otherwise use template_file name
  const destName = item.dest ?? basename(item.template_file);
  const destPath = join(destDir, destName);

  // Validate dest doesn't escape worktree
  if (item.dest) {
    validateDestPath(destPath, destDir, item.dest);
  }

  try {
    await mkdir(dirname(destPath), { recursive: true });

    const content = await sourceFile.text();
    const processed = processTemplate(content, options.env ?? {});
    await Bun.write(destPath, processed);

    const destRelative = relative(destDir, destPath);
    if (destRelative !== item.template_file) {
      options.ctx?.log(`  Templated: ${item.template_file} -> ${destRelative}`);
    } else {
      options.ctx?.log(`  Templated: ${item.template_file}`);
    }
  } catch (err) {
    throw wrapError(`Failed to process template '${item.template_file}'`, err);
  }
}

/**
 * Process an inline template item.
 */
async function processInlineTemplateItem(
  item: InlineTemplateItem,
  destDir: string,
  options: ProcessFilesOptions,
): Promise<void> {
  const destPath = join(destDir, item.dest);

  // Validate dest doesn't escape worktree
  validateDestPath(destPath, destDir, item.dest);

  try {
    await mkdir(dirname(destPath), { recursive: true });

    const processed = processTemplate(item.inline_template, options.env ?? {});
    await Bun.write(destPath, processed);

    options.ctx?.log(`  Created: ${item.dest} (from inline template)`);
  } catch (err) {
    throw wrapError(`Failed to create '${item.dest}' from inline template`, err);
  }
}

/**
 * Process files according to the files schema.
 * Handles:
 * - string: simple glob copy
 * - { source, dest? }: copy with optional custom destination
 * - { template_file, dest? }: file-based template
 * - { inline_template, dest }: inline template content
 *
 * @param items - Array of file items to process
 * @param sourceDir - Source directory to copy from
 * @param destDir - Destination directory (new worktree)
 * @param options - Processing options (env for templates, ctx for logging)
 */
export async function processFiles(
  items: FileItem[],
  sourceDir: string,
  destDir: string,
  options: ProcessFilesOptions = {},
): Promise<void> {
  for (const item of items) {
    if (isString(item)) {
      await processStringItem(item, sourceDir, destDir, options);
    } else if (isInlineTemplateItem(item)) {
      // Check inline_template before template_file since both are objects
      await processInlineTemplateItem(item, destDir, options);
    } else if (isTemplateFileItem(item)) {
      await processTemplateFileItem(item, sourceDir, destDir, options);
    } else if (isCopyItem(item)) {
      await processCopyItem(item, sourceDir, destDir, options);
    }
  }
}

/**
 * Expand ~ to home directory in a path.
 */
function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (path === "~") {
    return homedir();
  }
  return path;
}

/**
 * Resolve the copy source directory path.
 *
 * @param copySource - Directory path (relative to rootDir, absolute, or ~/...)
 * @param rootDir - Bare repo root directory (for relative paths)
 * @returns Resolved absolute path
 */
export async function resolveCopySource(copySource: string, rootDir: string): Promise<string> {
  const expanded = expandPath(copySource);
  const resolved = isAbsolute(expanded) ? expanded : join(rootDir, expanded);

  // Bun.file().exists() returns false for directories, so use stat() instead
  const stat = await Bun.file(resolved)
    .stat()
    .catch(() => null);
  if (!stat) {
    throw new Error(`Copy source does not exist: ${resolved}\n(configured as: ${copySource})`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Copy source is not a directory: ${resolved}\n(configured as: ${copySource})`);
  }

  return resolved;
}
