/**
 * Every worktree-scoped language server: one import and one entry per server, both sorted. The
 * manager's name gives its route (`/ws/<name>?wt=`), and `server.ts` dispatches and shuts down
 * from this list. Only lists belong in this file: a local `git merge` combines parallel additions
 * by itself (`merge=union` in `.gitattributes`). GitHub's own merge ignores that and reports a
 * conflict when two branches insert at the same spot; merging main locally then needs no edits.
 */
import { AstroLspManager } from "./astro-lsp-manager";
import { BiomeLspManager } from "./biome-lsp-manager";
import { CheckstyleLspManager } from "./checkstyle-lsp-manager";
import { ClangdLspManager } from "./clangd-lsp-manager";
import { CSharpLspManager } from "./csharp-lsp-manager";
import { DockerLspManager } from "./docker-lsp-manager";
import { EslintLspManager } from "./eslint-lsp-manager";
import { GoLspManager } from "./go-lsp-manager";
import { GolangciLintLspManager } from "./golangci-lint-lsp-manager";
import { JavaLspManager } from "./java-lsp-manager";
import { KotlinLintLspManager } from "./kotlin-lint-lsp-manager";
import { MypyLspManager } from "./mypy-lsp-manager";
import { OxlintLspManager } from "./oxlint-lsp-manager";
import { PythonLspManager } from "./python-lsp-manager";
import { RuffLspManager } from "./ruff-lsp-manager";
import { RustLspManager } from "./rust-lsp-manager";
import type { WorktreeLspServer } from "./server-state";
import { TerraformLspManager } from "./terraform-lsp-manager";
import { TomlLspManager } from "./toml-lsp-manager";
import { TsLspManager } from "./ts-lsp-manager";
import { XmlLspManager } from "./xml-lsp-manager";

// mypy, in projects configured for it, takes over basedpyright's type-checking diagnostics.
const mypyLspManager = new MypyLspManager();

export const tomlLspManager = new TomlLspManager({});

export const worktreeLspManagers: readonly WorktreeLspServer[] = [
  new AstroLspManager(),
  new CheckstyleLspManager(),
  new BiomeLspManager(),
  new ClangdLspManager(),
  new CSharpLspManager(),
  new DockerLspManager(),
  new EslintLspManager(),
  new GoLspManager(),
  new GolangciLintLspManager(),
  new JavaLspManager(),
  new KotlinLintLspManager(),
  new OxlintLspManager(),
  new PythonLspManager(mypyLspManager),
  // After Python, which hears from it while it shuts down.
  mypyLspManager,
  new RuffLspManager(),
  new RustLspManager(),
  new TerraformLspManager(),
  tomlLspManager,
  new TsLspManager(),
  new XmlLspManager(),
];
