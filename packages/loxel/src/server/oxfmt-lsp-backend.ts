import type { FileSink, Subprocess } from "bun";

import { type FormatterBackend, idleTimer, killProcessGroup } from "./formatter-backends";
import { projectToolPath } from "./js-formatter";
import { logger } from "./logger";
import { fileUri } from "./lsp-file-uri";
import { isRepoTrusted } from "./repo-trust";
import { buildSpawnEnv } from "./shell-env";
import { measureSpawn } from "./spawn-metrics";

const log = logger.child("format");

const FORMAT_TIMEOUT_MS = 5_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface LspTextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

export class OxfmtLspBackend implements FormatterBackend {
  private proc: Subprocess | null = null;
  private stdoutBuf = Buffer.alloc(0);
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private initPromise: Promise<boolean> | null = null;
  private dead = false;

  private readonly idle = idleTimer(
    () => this.pendingRequests.size > 0,
    () => this.destroy(),
  );

  /**
   * `dir` is the workspace root oxfmt takes its config from, and the search for its install starts
   * at `toolDir`, both in the worktree `worktreePath`.
   */
  constructor(
    private readonly dir: string,
    private readonly toolDir: string,
    private readonly worktreePath: string,
  ) {}

  async format(content: string, filePath: string): Promise<string | null> {
    const ready = await this.ensureInitialized();
    if (!ready) return null;
    this.idle.touch();

    const uri = fileUri(filePath);
    const languageId = this.inferLanguageId(filePath);

    try {
      // Open document
      this.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text: content },
      });

      // Request formatting
      const edits = (await this.sendRequest("textDocument/formatting", {
        textDocument: { uri },
        options: { tabSize: 2, insertSpaces: true },
      })) as LspTextEdit[] | null;

      // Stopped meanwhile, which also answers null: that is not "no changes".
      if (this.dead) return null;

      // Close document
      this.sendNotification("textDocument/didClose", { textDocument: { uri } });

      if (!edits || edits.length === 0) return content; // no changes needed
      return applyTextEdits(content, edits);
    } catch (err) {
      log.warn("oxfmt LSP format failed", {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  isAlive(): boolean {
    return !this.dead;
  }

  destroy(): void {
    this.dead = true;
    this.idle.clear();
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pendingRequests.clear();
    if (this.proc) killProcessGroup(this.proc.pid);
    this.proc = null;
    this.initPromise = null;
    this.stdoutBuf = Buffer.alloc(0);
  }

  // ---------------------------------------------------------------------------
  // LSP lifecycle
  // ---------------------------------------------------------------------------

  private async ensureInitialized(): Promise<boolean> {
    if (this.dead) return false;
    // One start for concurrent saves; starting awaits before there is a process.
    this.initPromise ??= this.startAndInitialize();
    return this.initPromise;
  }

  private async startAndInitialize(): Promise<boolean> {
    const PATH = await projectToolPath(this.toolDir, this.worktreePath);
    const binary = Bun.which("oxfmt", { PATH });
    // Asked again here: nothing else separates the save's detection from this spawn.
    if (!binary || this.dead || !isRepoTrusted(this.worktreePath)) {
      log.warn("oxfmt not started", { dir: this.dir, found: binary !== null });
      this.dead = true;
      return false;
    }

    try {
      this.proc = measureSpawn("oxfmt", () =>
        Bun.spawn([binary, "--lsp"], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          // It takes its config from `rootUri`. A version manager's shim for `node` would act on
          // the pin files of a directory in the project.
          cwd: "/",
          env: { ...buildSpawnEnv(), PATH, MISE_NOT_FOUND_AUTO_INSTALL: "0" },
          detached: true,
        }),
      );

      // Start reading stdout for responses
      this.readStdout();
      this.readStderr();

      // Monitor process exit
      this.proc.exited.then((code) => {
        log.info("oxfmt LSP process exited", { code, dir: this.dir });
        // FormatService replaces a backend that is not alive.
        this.dead = true;
        this.proc = null;
        this.initPromise = null;
        // Reject all pending requests
        for (const pending of this.pendingRequests.values()) {
          clearTimeout(pending.timer);
          pending.resolve(null);
        }
        this.pendingRequests.clear();
      });

      // Send initialize request
      const result = (await this.sendRequest("initialize", {
        processId: process.pid,
        rootUri: fileUri(this.dir),
        capabilities: {},
      })) as { capabilities?: { documentFormattingProvider?: boolean } } | null;

      if (!result?.capabilities?.documentFormattingProvider) {
        log.warn("oxfmt LSP does not support formatting", { dir: this.dir });
        this.destroy();
        return false;
      }

      // Send initialized notification
      this.sendNotification("initialized", {});

      log.info("oxfmt LSP backend initialized", { dir: this.dir });
      return true;
    } catch (err) {
      log.warn("Failed to start oxfmt LSP", {
        dir: this.dir,
        error: err instanceof Error ? err.message : String(err),
      });
      this.destroy();
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC with Content-Length framing
  // ---------------------------------------------------------------------------

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.proc || this.proc.killed) return Promise.resolve(null);

    const id = ++this.requestId;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        log.warn("oxfmt LSP request timed out", { method, id });
        resolve(null);
      }, FORMAT_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, timer });
      this.writeToStdin(message);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.proc || this.proc.killed) return;
    const message = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.writeToStdin(message);
  }

  private writeToStdin(json: string): void {
    const stdin = this.proc?.stdin as FileSink | undefined;
    if (!stdin) return;
    const body = Buffer.from(json, "utf-8");
    const header = `Content-Length: ${body.byteLength}\r\n\r\n`;
    stdin.write(header);
    stdin.write(body);
  }

  // ---------------------------------------------------------------------------
  // Stdout reading with Content-Length framing
  // ---------------------------------------------------------------------------

  private async readStdout(): Promise<void> {
    const stdout = this.proc?.stdout as ReadableStream<Uint8Array> | undefined;
    if (!stdout) return;

    const reader = stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stdoutBuf = Buffer.concat([this.stdoutBuf, Buffer.from(value)]);
        this.drainMessages();
      }
    } catch {
      // Process exited
    }
  }

  private drainMessages(): void {
    while (true) {
      const headerEnd = this.stdoutBuf.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.stdoutBuf.subarray(0, headerEnd).toString("utf-8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.stdoutBuf = this.stdoutBuf.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1]!, 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.stdoutBuf.byteLength < messageEnd) break;

      const body = this.stdoutBuf.subarray(messageStart, messageEnd).toString("utf-8");
      this.stdoutBuf = this.stdoutBuf.subarray(messageEnd);

      this.handleMessage(body);
    }
  }

  private handleMessage(body: string): void {
    try {
      const msg: unknown = JSON.parse(body);
      if (typeof msg !== "object" || msg === null) return;

      const obj = msg as Record<string, unknown>;
      // Response to a request (has "id")
      if ("id" in obj && typeof obj.id === "number") {
        const pending = this.pendingRequests.get(obj.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(obj.id);
          pending.resolve(obj.result ?? null);
        }
      }
      // Notifications from server are ignored (diagnostics, etc.)
    } catch {
      // Malformed JSON
    }
  }

  // ---------------------------------------------------------------------------
  // Stderr logging
  // ---------------------------------------------------------------------------

  private async readStderr(): Promise<void> {
    const stderr = this.proc?.stderr as ReadableStream<Uint8Array> | undefined;
    if (!stderr) return;

    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) log.debug(`[oxfmt-lsp stderr] ${text.trim()}`);
      }
    } catch {
      // Process exited
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private inferLanguageId(filePath: string): string {
    const ext = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
    switch (ext) {
      case "ts":
        return "typescript";
      case "tsx":
        return "typescriptreact";
      case "js":
        return "javascript";
      case "jsx":
        return "javascriptreact";
      case "mts":
      case "cts":
        return "typescript";
      case "mjs":
      case "cjs":
        return "javascript";
      case "css":
        return "css";
      case "scss":
        return "scss";
      case "less":
        return "less";
      case "json":
        return "json";
      case "jsonc":
      case "json5":
        return "jsonc";
      case "md":
      case "mdx":
      case "markdown":
        return "markdown";
      case "yaml":
      case "yml":
        return "yaml";
      case "toml":
        return "toml";
      case "html":
        return "html";
      case "vue":
        return "vue";
      case "graphql":
      case "gql":
        return "graphql";
      default:
        return "plaintext";
    }
  }
}

// ---------------------------------------------------------------------------
// LSP text edit application
// ---------------------------------------------------------------------------

/**
 * Apply LSP TextEdit[] to source content.
 * Edits are applied in reverse document order to preserve earlier positions.
 */
function applyTextEdits(content: string, edits: LspTextEdit[]): string {
  let result = content;
  const lines = result.split("\n");

  // Sort edits in reverse document order (bottom-right first)
  const sorted = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
    return b.range.start.character - a.range.start.character;
  });

  for (const edit of sorted) {
    const startOffset = lineCharToOffset(lines, edit.range.start.line, edit.range.start.character);
    const endOffset = lineCharToOffset(lines, edit.range.end.line, edit.range.end.character);
    const before = result.slice(0, startOffset);
    const after = result.slice(endOffset);
    result = before + edit.newText + after;
    // Re-split after each edit since line offsets change
    // This is fine for the typical case of 1 whole-document edit
    lines.length = 0;
    lines.push(...result.split("\n"));
  }

  return result;
}

function lineCharToOffset(lines: string[], line: number, character: number): number {
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += lines[i]!.length + 1; // +1 for \n
  }
  offset += Math.min(character, lines[line]?.length ?? 0);
  return offset;
}
