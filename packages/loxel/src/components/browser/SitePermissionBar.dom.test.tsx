import { afterEach, describe, expect, jest, mock, test } from "bun:test";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BellIcon } from "lucide-react";

import { ANSWER_GUARD_MS, SitePermissionBar } from "./SitePermissionBar";

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

function renderBar(requestKey: string, text = "example.com wants to show notifications") {
  const answers = { allow: mock(), allowOnce: mock(), block: mock(), dismiss: mock() };
  const bar = (key: string, children: string) => (
    <SitePermissionBar
      requestKey={key}
      icon={BellIcon}
      onAllow={answers.allow}
      onAllowOnce={answers.allowOnce}
      onBlock={answers.block}
      onDismiss={answers.dismiss}
    >
      {children}
    </SitePermissionBar>
  );
  const view = render(bar(requestKey, text));
  return { answers, change: (key: string, children: string) => view.rerender(bar(key, children)) };
}

const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const elapse = (ms: number) => act(() => jest.advanceTimersByTime(ms));

describe("SitePermissionBar", () => {
  test("answer buttons ignore clicks until the request has been shown for a moment", () => {
    jest.useFakeTimers();
    const { answers } = renderBar("1");
    for (const name of ["Allow", "Allow this time", "Block"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
      click(name);
    }
    elapse(ANSWER_GUARD_MS - 1);
    click("Allow");
    expect(answers.allow).not.toHaveBeenCalled();
    elapse(1);
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
    click("Allow");
    click("Allow this time");
    click("Block");
    expect(answers.allow).toHaveBeenCalledTimes(1);
    expect(answers.allowOnce).toHaveBeenCalledTimes(1);
    expect(answers.block).toHaveBeenCalledTimes(1);
  });

  test("a change in what the bar asks turns the buttons off again", () => {
    jest.useFakeTimers();
    const { answers, change } = renderBar(
      "view notes.txt",
      "editor.example wants to view notes.txt",
    );
    elapse(ANSWER_GUARD_MS);
    change("edit notes.txt", "editor.example wants to edit notes.txt");
    expect(screen.getByRole("alert").textContent).toContain("edit notes.txt");
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    click("Allow");
    expect(answers.allow).not.toHaveBeenCalled();
    elapse(ANSWER_GUARD_MS);
    click("Allow");
    expect(answers.allow).toHaveBeenCalledTimes(1);
  });

  test("Not now, which only refuses, works at once", () => {
    jest.useFakeTimers();
    const { answers } = renderBar("1");
    click("Not now");
    expect(answers.dismiss).toHaveBeenCalledTimes(1);
  });
});
