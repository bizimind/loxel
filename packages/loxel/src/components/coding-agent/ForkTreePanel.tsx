/**
 * Fork tree sidebar panel.
 *
 * Shows the branch structure of the active agent session as a compact tree.
 * Each node represents a branch with its label and first user message preview.
 * SVG-based rendering similar to the git graph panel but narrower.
 */
import { GitFork } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { SessionRecordSnapshot } from "@/api/coding-agent-model";

import { wsClient } from "@/api/client";
import { useActiveAgentSession } from "@/hooks/useActiveAgentSession";
import { getBranchColor } from "@/lib/colors";
import { cn } from "@/lib/utils";
import { useCodingAgentStore } from "@/store/coding-agent";

const NODE_HEIGHT = 28;
const INDENT_WIDTH = 16;
const PADDING_LEFT = 12;
const PADDING_TOP = 8;
const NODE_RADIUS = 4;
const ACTIVE_NODE_RADIUS = 5;

interface TreeNode {
  branchId: string;
  label: string;
  messagePreview: string;
  messageCount: number;
  children: TreeNode[];
  depth: number;
  y: number;
  isActive: boolean;
}

/** Build a flat list of tree nodes from branch info, ordered depth-first. */
function buildTree(record: SessionRecordSnapshot): TreeNode[] {
  const branches = Object.values(record.branches);
  const childrenMap = new Map<string | null, typeof branches>();

  for (const branch of branches) {
    const parentId = branch.parentBranchId;
    const existing = childrenMap.get(parentId) ?? [];
    existing.push(branch);
    childrenMap.set(parentId, existing);
  }

  // Count messages per branch
  const messageCounts = new Map<string, number>();
  for (const msg of Object.values(record.messages)) {
    messageCounts.set(msg.branchId, (messageCounts.get(msg.branchId) ?? 0) + 1);
  }

  // Find first user message per branch for preview (sorted by createdAt for determinism)
  const firstUserMessages = new Map<string, string>();
  const userMessages = Object.values(record.messages)
    .filter((msg) => msg.role === "user")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const msg of userMessages) {
    if (!firstUserMessages.has(msg.branchId)) {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      firstUserMessages.set(msg.branchId, content.slice(0, 50));
    }
  }

  const result: TreeNode[] = [];

  function walk(parentId: string | null, depth: number): void {
    const children = childrenMap.get(parentId) ?? [];
    // Sort by creation time
    children.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const branch of children) {
      const node: TreeNode = {
        branchId: branch.id,
        label: branch.label,
        messagePreview: firstUserMessages.get(branch.id) ?? "",
        messageCount: messageCounts.get(branch.id) ?? 0,
        children: [],
        depth,
        y: result.length * NODE_HEIGHT + PADDING_TOP,
        isActive: branch.id === record.activeBranchId,
      };
      result.push(node);
      walk(branch.id, depth + 1);
    }
  }

  walk(null, 0);
  return result;
}

/** Get parent branch ID for a node to draw edges. */
function getParentBranchId(branchId: string, record: SessionRecordSnapshot): string | null {
  return record.branches[branchId]?.parentBranchId ?? null;
}

export function ForkTreePanel() {
  const activeSessionId = useActiveAgentSession();
  const branchInfo = useCodingAgentStore(
    (s) => (activeSessionId ? s.sessions[activeSessionId]?.branchInfo : null) ?? null,
  );
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);

  const treeNodes = useMemo(() => (branchInfo ? buildTree(branchInfo) : []), [branchInfo]);

  const handleResumeBranch = useCallback(
    (branchId: string) => {
      if (!activeSessionId || !branchInfo) return;

      const branchHead = branchInfo.branchHeads[branchId];
      if (!branchHead) return;

      const store = useCodingAgentStore.getState();
      const session = store.sessions[activeSessionId];
      if (!session?.codingAgentSessionId) return;
      if (session.status === "running") return;

      // Clear timeline and reset for replay from the new branch
      store.clearTimeline(activeSessionId);

      wsClient.send({
        type: "agent_request",
        id: activeSessionId,
        request: {
          type: "session.resume",
          request_id: crypto.randomUUID(),
          session_id: session.codingAgentSessionId,
          rewind_to_message_id: branchHead,
        },
      });
    },
    [activeSessionId, branchInfo],
  );

  if (!activeSessionId) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-4 text-center text-sm">
        <div>
          <GitFork className="mx-auto mb-2 size-6 opacity-50" />
          <p>No agent panel active</p>
        </div>
      </div>
    );
  }

  if (!branchInfo || treeNodes.length === 0) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-4 text-center text-sm">
        <p>No branches yet</p>
      </div>
    );
  }

  const totalHeight = treeNodes.length * NODE_HEIGHT + PADDING_TOP * 2;
  const maxDepth = Math.max(...treeNodes.map((n) => n.depth));
  const totalWidth = PADDING_LEFT * 2 + (maxDepth + 1) * INDENT_WIDTH + 200;

  // Build a map of branchId → tree node for edge rendering
  const nodeByBranch = new Map(treeNodes.map((n) => [n.branchId, n]));

  return (
    <div className="h-full overflow-auto">
      <div className="relative" style={{ height: totalHeight, minWidth: totalWidth }}>
        {/* SVG layer for edges and nodes */}
        <svg className="pointer-events-none absolute inset-0" width="100%" height={totalHeight}>
          {/* Edges */}
          {treeNodes.map((node) => {
            const parentId = getParentBranchId(node.branchId, branchInfo);
            if (!parentId) return null;
            const parentNode = nodeByBranch.get(parentId);
            if (!parentNode) return null;

            const fromX = PADDING_LEFT + parentNode.depth * INDENT_WIDTH;
            const fromY = parentNode.y + NODE_HEIGHT / 2;
            const toX = PADDING_LEFT + node.depth * INDENT_WIDTH;
            const toY = node.y + NODE_HEIGHT / 2;

            // Draw an L-shaped path: vertical from parent, then horizontal to child
            const midY = toY;
            const path = `M ${fromX} ${fromY} L ${fromX} ${midY} L ${toX} ${midY}`;

            return (
              <path
                key={`edge-${node.branchId}`}
                d={path}
                fill="none"
                stroke={getBranchColor(node.label)}
                strokeWidth={1.5}
                opacity={0.5}
              />
            );
          })}

          {/* Nodes */}
          {treeNodes.map((node) => {
            const cx = PADDING_LEFT + node.depth * INDENT_WIDTH;
            const cy = node.y + NODE_HEIGHT / 2;
            const color = getBranchColor(node.label);
            const radius = node.isActive ? ACTIVE_NODE_RADIUS : NODE_RADIUS;

            return (
              <circle
                key={`node-${node.branchId}`}
                cx={cx}
                cy={cy}
                r={radius}
                fill={node.isActive ? color : "none"}
                stroke={color}
                strokeWidth={node.isActive ? 0 : 1.5}
              />
            );
          })}
        </svg>

        {/* HTML labels layer */}
        {treeNodes.map((node) => {
          const labelX = PADDING_LEFT + node.depth * INDENT_WIDTH + NODE_RADIUS + 8;

          return (
            <button
              key={`label-${node.branchId}`}
              type="button"
              className={cn(
                "absolute flex items-center gap-1.5 rounded px-1.5 text-left text-xs",
                selectedBranchId === node.branchId && "bg-primary",
                node.isActive && "font-medium",
                !node.isActive && "text-muted-foreground",
                "hover:bg-primary/50",
              )}
              style={{
                left: labelX,
                top: node.y + 4,
                height: NODE_HEIGHT - 8,
                maxWidth: `calc(100% - ${labelX + 8}px)`,
              }}
              onClick={() => setSelectedBranchId(node.branchId)}
              onDoubleClick={() => handleResumeBranch(node.branchId)}
            >
              <span className="shrink-0 truncate">{node.label}</span>
              {node.messagePreview && (
                <span className="text-muted-foreground/70 min-w-0 truncate italic">
                  {node.messagePreview}
                </span>
              )}
              <span className="text-muted-foreground/50 shrink-0 text-[10px]">
                ({node.messageCount})
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
