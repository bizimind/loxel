import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { type AgentTerminalAsk, EMPTY_AGENT_TERMINALS_STATE } from "@/api/agent-terminal-model";
import { localServerId } from "@/api/local-server";
import { WINDOW_ID } from "@/lib/window-id";

const answers: unknown[][] = [];

const originalClient = await import("@/api/client");
await mock.module("@/api/client", () => ({
  ...originalClient,
  answerAgentTerminal: async (server: string, ...args: unknown[]) => {
    expect(server).toBe(localServerId());
    answers.push(args);
  },
}));

const { useAgentTerminalsStore } = await import("@/store/agent-terminals");
const { AgentTerminalPrompt } = await import("./AgentTerminalPrompt");
const { originTooltip } = await import("@/components/dockview/terminal-tab");

const ask = (id: string, overrides: Partial<AgentTerminalAsk> = {}): AgentTerminalAsk => ({
  id,
  askedAt: 0,
  windowId: WINDOW_ID,
  origin: { agent: "Claude Code" },
  cwd: "/projects/app",
  worktreePath: "/projects/app",
  command: "pnpm dev",
  ...overrides,
});

beforeEach(() => {
  answers.length = 0;
  useAgentTerminalsStore.setState(EMPTY_AGENT_TERMINALS_STATE);
});

afterEach(cleanup);

describe("AgentTerminalPrompt", () => {
  test("asks only in the window the server asks in", () => {
    useAgentTerminalsStore.setState({ asks: [ask("a", { windowId: "another-window" })] });
    render(<AgentTerminalPrompt />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  test("names the agent, the worktree and the command, and sends each answer", async () => {
    useAgentTerminalsStore.setState({ asks: [ask("a"), ask("b")] });
    render(<AgentTerminalPrompt />);

    expect(
      screen.getByText(/Claude Code wants to start a terminal in app \(1 of 2\)/),
    ).toBeTruthy();
    expect(screen.getByText("pnpm dev")).toBeTruthy();
    expect(screen.queryByText(/Starts in/)).toBeNull();
    for (const name of ["Run", "Always in this worktree", "Don't run"]) {
      const button = screen.getByRole("button", { name });
      fireEvent.click(button);
      // The buttons come back once the server has the answer.
      await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    }

    expect(answers).toEqual([
      ["a", "run", WINDOW_ID],
      ["a", "always", WINDOW_ID],
      ["a", "decline", WINDOW_ID],
    ]);
  });

  test("says where the shell starts when it is not the worktree", () => {
    useAgentTerminalsStore.setState({ asks: [ask("a", { cwd: "/tmp/elsewhere" })] });
    render(<AgentTerminalPrompt />);

    expect(screen.getByText("Starts in /tmp/elsewhere")).toBeTruthy();
  });

  test("offers no Always for Home, and names an unknown agent", () => {
    useAgentTerminalsStore.setState({
      asks: [ask("a", { origin: {}, worktreePath: null, command: undefined })],
    });
    render(<AgentTerminalPrompt />);

    expect(screen.getByText(/An agent wants to start a terminal in Home/)).toBeTruthy();
    expect(screen.getByText(/An interactive shell/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Always in this worktree" })).toBeNull();
  });
});

describe("originTooltip", () => {
  test("names the agent, and the terminal and worktree it ran in", () => {
    const origin = { agent: "Codex", terminalId: "t1", worktreePath: "/projects/app" };
    expect(originTooltip(origin, "zsh")).toBe('Started by Codex from the terminal "zsh" in app');
    expect(originTooltip(origin, undefined)).toBe("Started by Codex from a terminal in app");
    expect(originTooltip({ terminalId: "t1" }, undefined)).toBe(
      "Started by an agent from a terminal in Home",
    );
    expect(originTooltip({ agent: "Codex" }, undefined)).toBe("Started by Codex");
  });
});
