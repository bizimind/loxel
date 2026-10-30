/**
 * Every worktree-scoped language server: one import and one entry per server, both sorted. The
 * manager's name gives its route (`/ws/<name>?wt=`), and `server.ts` dispatches and shuts down
 * from this list. Only lists belong in this file: a local `git merge` combines parallel additions
 * by itself (`merge=union` in `.gitattributes`). GitHub's own merge ignores that and reports a
 * conflict when two branches insert at the same spot; merging main locally then needs no edits.
 */
import { AstroLspManager } from "./astro-lsp-manager";
import { DockerLspManager } from "./docker-lsp-manager";
import { JavaLspManager } from "./java-lsp-manager";
import { MypyLspManager } from "./mypy-lsp-manager";
import { PythonLspManager } from "./python-lsp-manager";
import { RuffLspManager } from "./ruff-lsp-manager";
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
  new DockerLspManager(),
  new JavaLspManager(),
  new PythonLspManager(mypyLspManager),
  // After Python, which hears from it while it shuts down.
  mypyLspManager,
  new RuffLspManager(),
  new TerraformLspManager(),
  tomlLspManager,
  new TsLspManager(),
  new XmlLspManager(),
];
