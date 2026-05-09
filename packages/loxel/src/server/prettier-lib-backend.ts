import { join } from "node:path";

import type { FormatterBackend } from "./formatter-backends";

import { logger } from "./logger";

const log = logger.child("format");

interface PrettierModule {
  format(source: string, options: Record<string, unknown>): Promise<string>;
  resolveConfig(filepath: string): Promise<Record<string, unknown> | null>;
}

export class PrettierLibBackend implements FormatterBackend {
  private prettier: PrettierModule | null = null;
  private loadPromise: Promise<PrettierModule | null> | null = null;
  private loadFailed = false;

  constructor(private worktreePath: string) {}

  async format(content: string, filePath: string): Promise<string | null> {
    const prettier = this.prettier ?? (await this.loadPrettier());
    if (!prettier) return null;

    try {
      const config = (await prettier.resolveConfig(filePath)) ?? {};
      return await prettier.format(content, { ...config, filepath: filePath });
    } catch (err) {
      log.warn("Prettier format failed", {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  isAlive(): boolean {
    return !this.loadFailed;
  }

  destroy(): void {
    this.prettier = null;
    this.loadPromise = null;
    this.loadFailed = false;
  }

  private async loadPrettier(): Promise<PrettierModule | null> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.doLoad();
    return this.loadPromise;
  }

  private async doLoad(): Promise<PrettierModule | null> {
    const prettierPath = join(this.worktreePath, "node_modules", "prettier");
    try {
      const mod: unknown = await import(prettierPath);
      if (typeof mod !== "object" || mod === null || !("format" in mod)) {
        log.warn("Prettier module missing format function", { worktreePath: this.worktreePath });
        this.loadFailed = true;
        return null;
      }
      const prettier = mod as PrettierModule;
      this.prettier = prettier;
      log.info("Loaded prettier library backend", { worktreePath: this.worktreePath });
      return prettier;
    } catch (err) {
      log.warn("Failed to load prettier from node_modules", {
        worktreePath: this.worktreePath,
        error: err instanceof Error ? err.message : String(err),
      });
      this.loadFailed = true;
      return null;
    }
  }
}
