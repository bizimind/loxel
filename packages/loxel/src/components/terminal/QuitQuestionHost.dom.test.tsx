import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { QuitQuestion } from "@/lib/quit-terminals";
import { useSettingsStore } from "@/store/settings-store";
import { stubElectronAPI } from "@/test/electron-api-stub";

import { QuitQuestionHost } from "./QuitQuestionHost";

const quitQuestionShown = jest.fn((_id: number) => {});
const answerQuitQuestion = jest.fn((_reply: unknown) => {});
const setWhenQuitting = jest.fn((_setting: unknown) => {});
let ask: ((question: unknown) => void) | null = null;

const QUESTION: QuitQuestion = {
  id: 7,
  confirmation: {
    title: "Programs are running in 2 terminals",
    message: "Quitting ends them, unless you keep them running until Loxel opens again.",
    busy: [
      { id: "t1", program: "claude", worktree: "feat-cart" },
      { id: "t2", program: "pnpm", worktree: "Home" },
    ],
  },
};

function renderHost(): void {
  render(<QuitQuestionHost />);
}

function askQuestion(question: unknown = QUESTION): void {
  if (!ask) throw new Error("The host did not listen for quit questions");
  const deliver = ask;
  act(() => deliver(question));
}

beforeEach(() => {
  quitQuestionShown.mockClear();
  answerQuitQuestion.mockClear();
  setWhenQuitting.mockClear();
  ask = null;
  useSettingsStore.setState((s) => ({ terminal: { ...s.terminal, whenQuitting: "ask" } }));
  window.electronAPI = stubElectronAPI({
    quitQuestionShown,
    answerQuitQuestion,
    setWhenQuitting,
    onQuitQuestion: (callback) => {
      ask = callback;
      return () => {
        ask = null;
      };
    },
  });
});

afterEach(() => {
  cleanup();
  delete window.electronAPI;
});

describe("QuitQuestionHost", () => {
  test("shows main's question with the busy terminals, and reports it shown", () => {
    renderHost();
    askQuestion();
    expect(quitQuestionShown).toHaveBeenCalledWith(7);
    expect(screen.getByText("Programs are running in 2 terminals")).toBeInTheDocument();
    expect(screen.getByText("claude")).toBeInTheDocument();
    expect(screen.getByText("in Home")).toBeInTheDocument();
  });

  test("answers with the button the user picks", () => {
    renderHost();
    askQuestion();
    fireEvent.click(screen.getByRole("button", { name: "Quit and Keep Terminals" }));
    expect(answerQuitQuestion).toHaveBeenLastCalledWith({ id: 7, answer: "keep" });

    askQuestion({ ...QUESTION, id: 8 });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(answerQuitQuestion).toHaveBeenLastCalledWith({ id: 8, answer: "cancel" });
    expect(useSettingsStore.getState().terminal.whenQuitting).toBe("ask");
  });

  test("Don't ask again makes the answer the setting", () => {
    renderHost();
    askQuestion();
    fireEvent.click(screen.getByRole("checkbox", { name: "Don't ask again" }));
    fireEvent.click(screen.getByRole("button", { name: "Quit and End Terminals" }));
    expect(answerQuitQuestion).toHaveBeenLastCalledWith({ id: 7, answer: "end" });
    expect(useSettingsStore.getState().terminal.whenQuitting).toBe("end");
  });

  test("reports the When quitting Loxel setting to main, and each change of it", () => {
    renderHost();
    expect(setWhenQuitting).toHaveBeenLastCalledWith("ask");
    act(() => useSettingsStore.getState().updateTerminal({ whenQuitting: "keep" }));
    expect(setWhenQuitting).toHaveBeenLastCalledWith("keep");
  });

  test("ignores a malformed question, so main asks natively", () => {
    renderHost();
    askQuestion({ id: "seven" });
    expect(quitQuestionShown).not.toHaveBeenCalled();
    expect(document.querySelector("dialog[open]")).toBeNull();
  });
});
