import {
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  Globe,
  HelpCircle,
  Loader2,
  Pencil,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { useId, useState } from "react";

/**
 * Tool use card for coding agent timeline.
 * Adapted from ccm-web ToolUseCard — compact, collapsible, with tool icons.
 */
import { cn } from "@/lib/utils";

const toolIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  Read: FileText,
  Write: Pencil,
  Edit: Pencil,
  MultiEdit: Pencil,
  Bash: Terminal,
  Grep: Search,
  Glob: FolderOpen,
  WebSearch: Globe,
  WebFetch: Globe,
  AskUserQuestion: HelpCircle,
  Task: Wrench,
  TaskOutput: Terminal,
};

interface ToolUseCardProps {
  name: string;
  input: Record<string, unknown>;
  result?: { content: string; is_error?: boolean };
  isRunning?: boolean;
}

export function ToolUseCard({ name, input, result, isRunning }: ToolUseCardProps) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();

  const Icon = toolIcons[name] ?? Wrench;
  const preview = getInputPreview(name, input);

  return (
    <div className="overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="text-muted-foreground/70 flex w-full items-center gap-1.5 py-0.5 text-left text-xs"
        aria-expanded={expanded}
        aria-controls={contentId}
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        )}
        <Icon className="size-3 shrink-0 opacity-70" />
        <span className="font-medium">{name}</span>
        {!result && isRunning && <Loader2 className="size-3 shrink-0 animate-spin" />}
        {result?.is_error && <Bug className="text-destructive/40 size-3 shrink-0" />}
        {result && !result.is_error && <Check className="size-3 shrink-0 text-green-500/40" />}
        {!result && !isRunning && (
          <span className="text-muted-foreground/50 text-xs">interrupted</span>
        )}
        {preview && <span className="min-w-0 flex-1 truncate opacity-70">{preview}</span>}
      </button>

      {expanded && (
        <div
          id={contentId}
          className="text-muted-foreground/70 mt-1 space-y-1 pl-[18px] text-xs"
          role="region"
          aria-label={`${name} tool details`}
        >
          <pre className="font-mono break-all whitespace-pre-wrap">
            {JSON.stringify(input, null, 2)}
          </pre>
          {result && (
            <pre
              className={cn(
                "font-mono break-all whitespace-pre-wrap",
                result.is_error && "text-destructive",
              )}
            >
              {result.content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function getInputPreview(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return typeof input.file_path === "string" ? truncatePath(input.file_path) : "";
    case "Bash":
      return typeof input.command === "string" ? truncate(input.command, 50) : "";
    case "Grep":
    case "Glob":
      return typeof input.pattern === "string" ? truncate(input.pattern, 40) : "";
    case "WebSearch":
      return typeof input.query === "string" ? truncate(input.query, 40) : "";
    case "WebFetch":
      return typeof input.url === "string" ? truncate(input.url, 40) : "";
    case "Task":
      return typeof input.description === "string" ? truncate(input.description, 40) : "";
    default:
      return "";
  }
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
}

function truncatePath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 2) return path;
  return ".../" + parts.slice(-2).join("/");
}
