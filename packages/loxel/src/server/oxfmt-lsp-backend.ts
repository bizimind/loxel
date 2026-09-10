import { join } from "node:path";

import type { FileSink, Subprocess } from "bun";

import type { FormatterBackend } from "./formatter-backends";
import { logger } from "./logger";
import { buildSpawnEnv } from "./shell-env";

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

  constructor(private worktreePath: string) {}

  async format(content: string, filePath: string): Promise<string | null> {
    const ready = await this.ensureInitialized();
    if (!ready) return null;

    const uri = `file://${filePath}`;
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
    return !this.dead && this.proc !== null && !this.proc.killed;
  }

  destroy(): void {
    this.dead = true;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pendingRequests.clear();
    if (this.proc) {
      try {
        this.sendNotification("shutdown", {});
        this.proc.kill();
      } catch {
        // Already dead
      }
      this.proc = null;
    }
    this.initPromise = null;
    this.stdoutBuf = Buffer.alloc(0);
  }

  // ---------------------------------------------------------------------------
  // LSP lifecycle
  // ---------------------------------------------------------------------------

  private async ensureInitialized(): Promise<boolean> {
    if (this.dead) return false;
    if (this.proc && !this.proc.killed && this.initPromise) return this.initPromise;

    // Start fresh
    this.initPromise = this.startAndInitialize();
    return this.initPromise;
  }

  private async startAndInitialize(): Promise<boolean> {
    const binary = this.resolveBinary();
    if (!binary) {
      log.warn("oxfmt binary not found", { worktreePath: this.worktreePath });
      this.dead = true;
      return false;
    }

    const env = buildSpawnEnv();
    const localBin = join(this.worktreePath, "node_modules", ".bin");
    env.PATH = env.PATH ? `${localBin}:${env.PATH}` : localBin;

    try {
      this.proc = Bun.spawn([binary, "--lsp"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: this.worktreePath,
        env,
      });

      // Start reading stdout for responses
      this.readStdout();
      this.readStderr();

      // Monitor process exit
      this.proc.exited.then((code) => {
        log.info("oxfmt LSP process exited", { code, worktreePath: this.worktreePath });
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
        rootUri: `file://${this.worktreePath}`,
        capabilities: {},
      })) as { capabilities?: { documentFormattingProvider?: boolean } } | null;

      if (!result?.capabilities?.documentFormattingProvider) {
        log.warn("oxfmt LSP does not support formatting", { worktreePath: this.worktreePath });
        this.destroy();
        return false;
      }

      // Send initialized notification
      this.sendNotification("initialized", {});

      log.info("oxfmt LSP backend initialized", { worktreePath: this.worktreePath });
      return true;
    } catch (err) {
      log.warn("Failed to start oxfmt LSP", {
        worktreePath: this.worktreePath,
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

  private resolveBinary(): string | null {
    // Check node_modules/.bin first
    const localBin = join(this.worktreePath, "node_modules", ".bin", "oxfmt");
    if (Bun.file(localBin).size) return localBin;

    return Bun.which("oxfmt");
  }

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
      case "css":
        return "css";
      case "json":
        return "json";
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
