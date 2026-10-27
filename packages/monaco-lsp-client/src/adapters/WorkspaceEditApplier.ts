import * as monaco from "monaco-editor";
import picomatch from "picomatch";

import type {
  ApplyWorkspaceEditResult,
  CreateFile,
  DeleteFile,
  FileOperationFilter,
  Position,
  RenameFile,
  TextEdit,
  WorkspaceEdit,
} from "../types";
import {
  api,
  capabilities,
  FailureHandlingKind,
  FileOperationPatternKind,
  ResourceOperationKind,
} from "../types";
import { Disposable } from "../utils";
import type { ILspCapabilitiesRegistry } from "./LspCapabilitiesRegistry";

export type WorkspaceFileType = "file" | "directory";

/**
 * Disk access for workspace edits (rename, code actions, `workspace/applyEdit`): files with no
 * Monaco model are read and written through it, and file create/rename/delete operations run
 * through it. Uris are the server's. A thrown error's message becomes the reason the edit failed.
 */
export interface WorkspaceFileSystem {
  /**
   * What is at `uri`, or undefined when nothing is. Called before anything changes for every
   * resource an edit touches, so throwing refuses the whole edit: use it to keep edits out of files
   * they must not change (outside the workspace, dependencies). Open models that only text edits
   * touch are the exception: those edits change the model, as typing in it would, not the disk.
   */
  stat(uri: monaco.Uri): Promise<WorkspaceFileType | undefined>;
  readFile(uri: monaco.Uri): Promise<string>;
  /** Replace the content of an existing file. */
  writeFile(uri: monaco.Uri, content: string): Promise<void>;
  /** Create an empty file where nothing exists. */
  createFile(uri: monaco.Uri): Promise<void>;
  /** Rename or move a file or folder to a path where nothing exists. */
  rename(source: monaco.Uri, target: monaco.Uri): Promise<void>;
  /** Delete a file, or a folder with everything in it. */
  delete(uri: monaco.Uri): Promise<void>;
}

export interface WorkspaceEditApplierOptions {
  /** Without it only files with an open model can be edited, and file operations are refused. */
  fileSystem?: WorkspaceFileSystem;
  /** Called with the reason whenever an edit is refused or fails part way, to tell the user. */
  onFailure?: (reason: string) => void;
}

type Step = { change: number; label: string } & (
  | {
      kind: "model";
      model: monaco.editor.ITextModel;
      /** The version planned against; only the first step on a model has one. */
      versionId: number | undefined;
      operations: monaco.editor.IIdentifiedSingleEditOperation[];
    }
  | { kind: "write"; uri: monaco.Uri; expected: string; content: string }
  | { kind: "create"; uri: monaco.Uri }
  | { kind: "rename"; source: monaco.Uri; target: monaco.Uri }
  | { kind: "delete"; uri: monaco.Uri }
);

/** What a path holds at the current point of the plan. */
type Entry =
  /** Nothing on disk; a model may still be open on it (a file deleted while open). */
  | { type: "missing"; model?: monaco.editor.ITextModel }
  | { type: "directory" }
  /** A file with an open model, which text edits change. */
  | { type: "model"; model: monaco.editor.ITextModel }
  /** A file with no model. `text` is its content at this point of the plan, read on first need. */
  | { type: "disk"; readFrom: monaco.Uri; text?: string }
  /** An open file renamed earlier in the edit: its content is on its way to a moved editor. */
  | { type: "moved" };

/**
 * Applies LSP workspace edits for every feature that produces one, so rename, code actions and
 * `workspace/applyEdit` share one path instead of Monaco's standalone bulk-edit service, which
 * can only edit open models.
 *
 * An edit is planned whole before anything changes: every resource but an open model that is only
 * text-edited is checked (`stat`), files without a model are read and edited in memory, versions
 * and overlapping edits are validated.
 * Only then are the changes executed in order: text edits to open models one undo stop per change,
 * other files written back after checking they did not change on disk since they were read, file
 * operations through the file system. A failure there stops the edit, keeping what was already
 * applied (`failureHandling: "abort"`), and the reason says how far it got. Disposing stops it:
 * queued edits are refused and one being applied stops before its next change, so an edit never
 * outlives the connection (and worktree) it was made for.
 */
export class WorkspaceEditApplier extends Disposable {
  /** Filters of the server's `workspace/willRenameFiles` registrations. */
  private readonly _willRenameFilters = new Set<readonly FileOperationFilter[]>();

  constructor(
    private readonly _server: typeof api.TServerInterface,
    registry: ILspCapabilitiesRegistry,
    private readonly _options: WorkspaceEditApplierOptions = {},
  ) {
    super();
    if (!_options.fileSystem) {
      this._register(
        registry.addStaticClientCapabilities({
          workspace: { workspaceEdit: { documentChanges: true } },
        }),
      );
      return;
    }

    this._register(
      registry.addStaticClientCapabilities({
        workspace: {
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: [
              ResourceOperationKind.Create,
              ResourceOperationKind.Rename,
              ResourceOperationKind.Delete,
            ],
            failureHandling: FailureHandlingKind.Abort,
          },
          fileOperations: { dynamicRegistration: true, willRename: true },
        },
      }),
    );
    this._register(
      registry.registerCapabilityHandler(capabilities.workspaceWillRenameFiles, true, (options) => {
        this._willRenameFilters.add(options.filters);
        return { dispose: () => this._willRenameFilters.delete(options.filters) };
      }),
    );
  }

  /** Why `edit` cannot be applied at all, known without touching any file. */
  unsupportedReason(edit: WorkspaceEdit): string | undefined {
    if (this._options.fileSystem || !edit.documentChanges) return undefined;
    for (const change of edit.documentChanges) {
      if (!("textDocument" in change)) return `File ${change.kind} operations are not supported`;
    }
    return undefined;
  }

  /** The edit being applied: edits apply one at a time, each planned against the last's result. */
  private _queue: Promise<unknown> = Promise.resolve();
  private _disposed = false;

  override dispose(): void {
    this._disposed = true;
    super.dispose();
  }

  apply(edit: WorkspaceEdit): Promise<ApplyWorkspaceEditResult> {
    const run = async () => {
      const result = await this._apply(edit);
      if (!result.applied) this._options.onFailure?.(result.failureReason ?? "The edit failed");
      return result;
    };
    const next = this._queue.then(run, run);
    this._queue = next.catch(() => {});
    return next;
  }

  private async _apply(edit: WorkspaceEdit): Promise<ApplyWorkspaceEditResult> {
    if (this._disposed) return { applied: false, failureReason: CLOSED_REASON };
    const unsupported = this.unsupportedReason(edit);
    if (unsupported) return { applied: false, failureReason: unsupported };

    let steps: Step[];
    try {
      steps = await new EditPlanner(this._options.fileSystem, (source, target, isFolder) =>
        this._willRename(source, target, isFolder),
      ).plan(edit);
    } catch (error) {
      return { applied: false, failureReason: errorMessage(error) };
    }

    // The plan read files asynchronously: refuse before changing anything if the user typed.
    const stale = steps.find((step) => step.kind === "model" && isStale(step));
    if (stale) {
      return {
        applied: false,
        failureReason: `${stale.label} changed while the edit was prepared`,
        failedChange: edit.documentChanges ? stale.change : undefined,
      };
    }

    for (const [index, step] of steps.entries()) {
      try {
        if (this._disposed) throw new Error(CLOSED_REASON);
        await this._execute(step);
      } catch (error) {
        const reason = errorMessage(error);
        return {
          applied: false,
          failureReason:
            index === 0 ? reason : `${reason} (${index} of ${steps.length} changes were applied)`,
          failedChange: edit.documentChanges ? step.change : undefined,
        };
      }
    }
    return { applied: true };
  }

  /**
   * Asks the server for the edits a rename implies (imports of a moved module) when it registered
   * for `workspace/willRenameFiles` on that path, as it would for a rename made in the file tree:
   * a server's own rename edit may hold a bare file rename and rely on this for the references.
   */
  private async _willRename(
    source: monaco.Uri,
    target: monaco.Uri,
    isFolder: boolean,
  ): Promise<WorkspaceEdit | null> {
    const kind = isFolder ? FileOperationPatternKind.folder : FileOperationPatternKind.file;
    const interested = [...this._willRenameFilters].some((filters) =>
      filters.some((filter) => matchesFileOperationFilter(filter, source.path, kind)),
    );
    if (!interested) return null;
    try {
      return await this._server.workspaceWillRenameFiles({
        files: [{ oldUri: source.toString(), newUri: target.toString() }],
      });
    } catch (error) {
      throw new Error(`Could not get the edits for renaming ${describe(source)}`, { cause: error });
    }
  }

  private async _execute(step: Step): Promise<void> {
    const fs = this._options.fileSystem;
    switch (step.kind) {
      case "model": {
        if (step.model.isDisposed()) throw new Error(`${step.label} was closed`);
        if (isStale(step)) throw new Error(`${step.label} changed while the edit was applied`);
        step.model.pushStackElement();
        step.model.pushEditOperations([], step.operations, () => null);
        step.model.pushStackElement();
        return;
      }
      case "write": {
        const current = await requireFs(fs).readFile(step.uri);
        if (current !== step.expected) {
          throw new Error(`${step.label} changed on disk while the edit was applied`);
        }
        return requireFs(fs).writeFile(step.uri, step.content);
      }
      case "create":
        return requireFs(fs).createFile(step.uri);
      case "rename":
        return requireFs(fs).rename(step.source, step.target);
      case "delete":
        return requireFs(fs).delete(step.uri);
      default: {
        const _exhaustive: never = step;
        throw new Error(`Unknown edit step: ${String(_exhaustive)}`);
      }
    }
  }
}

const CLOSED_REASON = "The language server connection closed";

function isStale(step: Extract<Step, { kind: "model" }>): boolean {
  return step.versionId !== undefined && step.model.getVersionId() !== step.versionId;
}

function requireFs(fs: WorkspaceFileSystem | undefined): WorkspaceFileSystem {
  if (!fs) throw new Error("No file system to apply the edit with");
  return fs;
}

/** Simulates an edit's changes in order, producing the steps that apply it. */
class EditPlanner {
  private readonly _entries = new Map<string, Entry>();
  /** Folders renamed away, renamed into, or deleted earlier in the edit. */
  private readonly _changedDirs: string[] = [];
  /** How many of `_changedDirs` existed when each entry was recorded. */
  private readonly _changedDirsSeen = new Map<string, number>();
  private readonly _versionedModels = new Set<monaco.editor.ITextModel>();
  /** Open models looked at for text edits only, so not checked with `stat` yet. */
  private readonly _unchecked = new Set<string>();
  private readonly _steps: Step[] = [];

  /** Set while planning the edits a rename implies, which do not ask for further ones. */
  private _inWillRename = false;

  constructor(
    private readonly _fs: WorkspaceFileSystem | undefined,
    private readonly _willRename: (
      source: monaco.Uri,
      target: monaco.Uri,
      isFolder: boolean,
    ) => Promise<WorkspaceEdit | null>,
  ) {}

  async plan(edit: WorkspaceEdit): Promise<Step[]> {
    await this._planEdit(edit);
    return this._steps;
  }

  /** Plans `edit`'s changes; `change` overrides their indexes (for edits a rename implies). */
  private async _planEdit(edit: WorkspaceEdit, change?: number): Promise<void> {
    if (edit.documentChanges) {
      for (const [index, documentChange] of edit.documentChanges.entries()) {
        if ("textDocument" in documentChange) {
          await this._textEdit(
            change ?? index,
            documentChange.textDocument.uri,
            documentChange.edits,
            documentChange.textDocument.version ?? undefined,
          );
        } else {
          await this._resourceOperation(change ?? index, documentChange);
        }
      }
    } else if (edit.changes) {
      for (const [index, [uri, edits]] of Object.entries(edit.changes).entries()) {
        await this._textEdit(change ?? index, uri, edits, undefined);
      }
    }
  }

  private async _textEdit(
    change: number,
    rawUri: string,
    edits: TextEdit[],
    version: number | undefined,
  ): Promise<void> {
    if (edits.length === 0) return;
    const uri = parseUri(rawUri);
    const label = describe(uri);
    const entry = await this._entry(uri, true);
    if (entry.type === "moved") {
      throw new Error(`Editing ${label} after renaming it in the same edit is not supported`);
    }
    if (entry.type === "directory") throw new Error(`${label} is a folder`);

    const model = entry.type === "model" || entry.type === "missing" ? entry.model : undefined;
    if (model) {
      const first = !this._versionedModels.has(model);
      // A version only means something for the content the server saw: before this edit changed it.
      if (first && version !== undefined && version !== model.getVersionId()) {
        throw new Error(`${label} changed since the edit was computed`);
      }
      if (hasOverlappingRanges(edits)) throw new Error(`The edits to ${label} overlap`);
      this._versionedModels.add(model);
      this._steps.push({
        change,
        label,
        kind: "model",
        model,
        versionId: first ? model.getVersionId() : undefined,
        operations: edits.map((e) => ({
          range: toMonacoRange(e.range.start, e.range.end),
          text: e.newText,
          forceMoveMarkers: true,
        })),
      });
      return;
    }

    if (entry.type !== "disk") throw new Error(`${label} does not exist`);
    entry.text ??= await requireFs(this._fs).readFile(entry.readFrom);
    let content: string;
    try {
      content = applyTextEdits(entry.text, edits);
    } catch (error) {
      throw new Error(`The edits to ${label}: ${errorMessage(error)}`, { cause: error });
    }
    this._steps.push({ change, label, kind: "write", uri, expected: entry.text, content });
    entry.text = content;
  }

  private async _resourceOperation(
    change: number,
    operation: CreateFile | RenameFile | DeleteFile,
  ): Promise<void> {
    switch (operation.kind) {
      case "create":
        return this._create(change, operation);
      case "rename":
        return this._rename(change, operation);
      case "delete":
        return this._delete(change, operation);
      default: {
        const _exhaustive: never = operation;
        throw new Error(`Unknown file operation: ${String(_exhaustive)}`);
      }
    }
  }

  private async _create(change: number, operation: CreateFile): Promise<void> {
    const uri = parseUri(operation.uri);
    const label = describe(uri);
    const entry = await this._entry(uri);
    if (entry.type !== "missing") {
      if (!operation.options?.overwrite) {
        if (operation.options?.ignoreIfExists) return;
        throw new Error(`${label} already exists`);
      }
      if (entry.type !== "disk") throw new Error(`Overwriting ${label} is not supported`);
      entry.text ??= await requireFs(this._fs).readFile(entry.readFrom);
      this._steps.push({ change, label, kind: "write", uri, expected: entry.text, content: "" });
      entry.text = "";
      return;
    }
    this._steps.push({ change, label, kind: "create", uri });
    this._set(key(uri), { type: "disk", readFrom: uri, text: "" });
  }

  private async _rename(change: number, operation: RenameFile): Promise<void> {
    const source = parseUri(operation.oldUri);
    const target = parseUri(operation.newUri);
    const sourceEntry = await this._entry(source);
    if (sourceEntry.type === "missing" || sourceEntry.type === "moved") {
      throw new Error(`${describe(source)} does not exist`);
    }
    const targetEntry = await this._entry(target);
    if (targetEntry.type !== "missing") {
      if (!operation.options?.overwrite) {
        if (operation.options?.ignoreIfExists) return;
        throw new Error(`${describe(target)} already exists`);
      }
    }
    if (!this._inWillRename) {
      const implied = await this._willRename(source, target, sourceEntry.type === "directory");
      if (implied) {
        this._inWillRename = true;
        try {
          await this._planEdit(implied, change);
        } finally {
          this._inWillRename = false;
        }
      }
    }
    if (targetEntry.type !== "missing") {
      this._steps.push({ change, label: describe(target), kind: "delete", uri: target });
    }
    this._steps.push({ change, label: describe(source), kind: "rename", source, target });

    this._set(key(source), { type: "missing" });
    if (sourceEntry.type === "directory") {
      this._changedDirs.push(key(source), key(target));
      this._set(key(target), { type: "directory" });
    } else if (sourceEntry.type === "model") {
      this._set(key(target), { type: "moved" });
    } else {
      this._set(key(target), { ...sourceEntry });
    }
  }

  private async _delete(change: number, operation: DeleteFile): Promise<void> {
    const uri = parseUri(operation.uri);
    const label = describe(uri);
    const entry = await this._entry(uri);
    if (entry.type === "missing") {
      if (operation.options?.ignoreIfNotExists) return;
      throw new Error(`${label} does not exist`);
    }
    if (entry.type === "directory") {
      if (!operation.options?.recursive) {
        throw new Error(`Deleting the folder ${label} needs the recursive option`);
      }
      this._changedDirs.push(key(uri));
    }
    this._steps.push({ change, label, kind: "delete", uri });
    this._set(key(uri), { type: "missing" });
  }

  /**
   * What `uri` holds at this point of the plan. The first look checks it with `stat`, except for a
   * text edit to an open model, which is edited like typing in it would be: a file operation on it
   * later in the edit checks it then.
   */
  private async _entry(uri: monaco.Uri, forTextEdit = false): Promise<Entry> {
    const k = key(uri);
    // A folder renamed or deleted after the path was looked at changes it too.
    const seen = this._changedDirsSeen.get(k) ?? 0;
    if (this._changedDirs.slice(seen).some((dir) => k.startsWith(`${dir}/`))) {
      throw new Error(
        `Changing ${describe(uri)} inside a folder renamed or deleted in the same edit is not supported`,
      );
    }
    const known = this._entries.get(k);
    if (known && (forTextEdit || !this._unchecked.has(k))) return known;

    const model = monaco.editor.getModel(uri) ?? undefined;
    let entry: Entry;
    if (!this._fs) {
      if (!model) throw new Error(`${describe(uri)} is not open in the editor`);
      entry = { type: "model", model };
    } else if (model && forTextEdit) {
      this._unchecked.add(k);
      entry = { type: "model", model };
    } else {
      this._unchecked.delete(k);
      const type = await this._fs.stat(uri);
      if (type === "directory") entry = { type: "directory" };
      else if (model)
        entry = type === "file" ? { type: "model", model } : { type: "missing", model };
      else entry = type === "file" ? { type: "disk", readFrom: uri } : { type: "missing" };
    }
    this._set(k, entry);
    return entry;
  }

  private _set(k: string, entry: Entry): void {
    this._entries.set(k, entry);
    this._changedDirsSeen.set(k, this._changedDirs.length);
  }
}

/** Parses a server uri, resolving `.` and `..` path segments (`src/./b.ts` names `src/b.ts`). */
function parseUri(value: string): monaco.Uri {
  const uri = monaco.Uri.parse(value);
  const segments = uri.path.split("/");
  if (!segments.some((s) => s === "." || s === "..")) return uri;
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "..") {
      if (resolved.length > 1) resolved.pop();
    } else if (segment !== ".") {
      resolved.push(segment);
    }
  }
  return uri.with({ path: resolved.join("/") || "/" });
}

function matchesFileOperationFilter(
  filter: FileOperationFilter,
  path: string,
  kind: FileOperationPatternKind,
): boolean {
  // The scheme is not compared: a client may show a server's `file:` documents under its own
  // scheme, and asking about a path the server does not care about only costs a null answer.
  const { glob, matches, options } = filter.pattern;
  if (matches && matches !== kind) return false;
  return picomatch.isMatch(path, glob, { dot: true, nocase: options?.ignoreCase });
}

function key(uri: monaco.Uri): string {
  return uri.toString();
}

function describe(uri: monaco.Uri): string {
  return uri.path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toMonacoRange(start: Position, end: Position): monaco.IRange {
  return {
    startLineNumber: start.line + 1,
    startColumn: start.character + 1,
    endLineNumber: end.line + 1,
    endColumn: end.character + 1,
  };
}

function comparePositions(a: Position, b: Position): number {
  return a.line === b.line ? a.character - b.character : a.line - b.line;
}

/**
 * Orders edits by start, an insert before a replace starting at the same place (they touch, which
 * the spec allows), and otherwise keeps their order.
 */
function sortByStart<T>(
  edits: readonly T[],
  compareStarts: (a: T, b: T) => number,
  isEmpty: (e: T) => boolean,
): T[] {
  return edits.toSorted((a, b) => compareStarts(a, b) || Number(isEmpty(b)) - Number(isEmpty(a)));
}

/** Monaco throws on overlapping edits mid-way, after other changes were already applied. */
function hasOverlappingRanges(edits: readonly TextEdit[]): boolean {
  const ranges = sortByStart(
    edits.map((e) => e.range),
    (a, b) => comparePositions(a.start, b.start),
    (r) => comparePositions(r.start, r.end) === 0,
  );
  return ranges.some((range, i) => {
    const previous = ranges[i - 1];
    if (comparePositions(range.end, range.start) < 0) return true;
    return previous !== undefined && comparePositions(range.start, previous.end) < 0;
  });
}

/**
 * Applies LSP text edits to `text`. Positions are UTF-16 offsets into `\n`, `\r\n` or `\r`
 * separated lines; a character past the end of its line means the line end, a line past the end
 * of the text means its end. Inserts at the same position keep their order. Throws on overlap.
 */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\r" && text[i + 1] === "\n") i++;
    if (char === "\n" || char === "\r") lineStarts.push(i + 1);
  }
  const offsetOf = (position: Position): number => {
    const start = lineStarts[position.line];
    if (start === undefined) return text.length;
    const next = lineStarts[position.line + 1];
    let lineEnd = next ?? text.length;
    if (next !== undefined) lineEnd -= text.slice(next - 2, next) === "\r\n" ? 2 : 1;
    return Math.min(start + position.character, lineEnd);
  };

  const spans = sortByStart(
    edits.map((e) => ({
      start: offsetOf(e.range.start),
      end: offsetOf(e.range.end),
      text: e.newText,
    })),
    (a, b) => a.start - b.start,
    (span) => span.start === span.end,
  );
  let result = "";
  let last = 0;
  for (const span of spans) {
    if (span.end < span.start) throw new Error("an edit's range ends before it starts");
    if (span.start < last) throw new Error("edits overlap");
    result += text.slice(last, span.start) + span.text;
    last = span.end;
  }
  return result + text.slice(last);
}
