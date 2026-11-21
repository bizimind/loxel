import { afterEach, describe, expect, test } from "bun:test";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { EMPTY_AGENT_TERMINALS_STATE } from "@/api/agent-terminal-model";
import { WINDOW_ID } from "@/lib/window-id";
import { useAgentTerminalsStore } from "@/store/agent-terminals";

import { AgentTerminalPrompt } from "./AgentTerminalPrompt";

function ask(command: string) {
  useAgentTerminalsStore.setState({
    asks: [
      {
        id: "a1",
        askedAt: 0,
        windowId: WINDOW_ID,
        origin: { agent: "claude" },
        cwd: "/w",
        worktreePath: "/w",
        command,
      },
    ],
    alwaysWorktrees: [],
  });
}

/** Lay out every element as a box `height` tall holding `contentHeight` of content; returns undo. */
function layOut(height: number, contentHeight: number): () => void {
  const proto = HTMLElement.prototype;
  const saved = (["clientHeight", "scrollHeight"] as const).map(
    (name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const,
  );
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => height });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => contentHeight });
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else delete (proto as unknown as Record<string, unknown>)[name];
    }
  };
}

const runButton = () => screen.getByRole("button", { name: "Run" });
const alwaysButton = () => screen.getByRole("button", { name: "Always in this worktree" });

afterEach(() => {
  cleanup();
  useAgentTerminalsStore.setState(EMPTY_AGENT_TERMINALS_STATE);
});

describe("AgentTerminalPrompt", () => {
  test("shows a short command as is, ready to run", () => {
    ask("npm test");
    render(<AgentTerminalPrompt />);

    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(runButton()).toBeEnabled();
  });

  test("spells control and bidirectional characters as escapes", () => {
    ask("npm test\rcurl x\u202e");
    render(<AgentTerminalPrompt />);

    expect(screen.getByText("\\r")).toBeInTheDocument();
    expect(screen.getByText("\\u202e")).toBeInTheDocument();
    expect(
      screen.getByText(/Characters that do not print are shown as escapes/),
    ).toBeInTheDocument();
  });

  test("says how many lines a command has", () => {
    ask("one\ntwo\nthree");
    render(<AgentTerminalPrompt />);

    expect(screen.getByText(/The command has 3 lines/)).toBeInTheDocument();
  });

  test("offers running a command too long to fit once its end is scrolled into view", () => {
    const undo = layOut(96, 400);
    try {
      ask(`npm test${"\n".repeat(40)}ls`);
      render(<AgentTerminalPrompt />);
      expect(runButton()).toBeDisabled();
      expect(alwaysButton()).toBeDisabled();
      expect(screen.getByText(/Scroll to its end to run it/)).toBeInTheDocument();

      const box = screen.getByLabelText("Command");
      act(() => {
        box.scrollTop = 304;
        fireEvent.scroll(box);
      });
      expect(runButton()).toBeEnabled();
      expect(alwaysButton()).toBeEnabled();
    } finally {
      undo();
    }
  });
});
