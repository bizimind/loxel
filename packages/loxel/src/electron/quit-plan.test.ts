import { describe, expect, test } from "bun:test";

import { QUIT, QUIT_KEEPING_TERMINALS, QuitPlans, RESTART, planAtWillQuit } from "./quit-plan";

describe("QuitPlans", () => {
  test("a quit nothing requested is a plain Quit, ending the terminals", () => {
    const plans = new QuitPlans();
    plans.begin();
    expect(plans.current()).toEqual({ terminals: "end", relaunch: false });
  });

  test("a quit follows the plan requested for it", () => {
    const plans = new QuitPlans();
    plans.request(QUIT_KEEPING_TERMINALS);
    plans.begin();
    expect(plans.current()).toEqual({ terminals: "keep", relaunch: false });
    plans.request(RESTART);
    plans.begin();
    expect(plans.current()).toEqual({ terminals: "keep", relaunch: true });
  });

  test("a cancelled quit's plan does not carry over to the next quit", () => {
    const plans = new QuitPlans();
    plans.request(RESTART);
    plans.begin();
    // A window refused to close; the user later quits from the Dock.
    plans.begin();
    expect(plans.current()).toBe(QUIT);
  });

  test("a plan requested while a quit is under way applies to it", () => {
    const plans = new QuitPlans();
    plans.begin();
    // ⌥⌘Q while ⌘Q's windows are still closing: Electron fires no second before-quit.
    plans.request(QUIT_KEEPING_TERMINALS);
    expect(plans.current()).toBe(QUIT_KEEPING_TERMINALS);
  });

  test("a quit started again after waiting for layout promotes keeps its plan", () => {
    const plans = new QuitPlans();
    plans.request(QUIT_KEEPING_TERMINALS);
    plans.begin();
    plans.request(plans.current());
    plans.begin();
    expect(plans.current()).toBe(QUIT_KEEPING_TERMINALS);
  });
});

describe("planAtWillQuit", () => {
  test("carries out the quit's plan when no update is installing", () => {
    expect(planAtWillQuit(RESTART, null)).toBe(RESTART);
    expect(planAtWillQuit(QUIT, null)).toBe(QUIT);
  });

  test("an update install does what the install says to the terminals, and never relaunches", () => {
    expect(planAtWillQuit(QUIT, "keep")).toEqual({ terminals: "keep", relaunch: false });
    expect(planAtWillQuit(RESTART, "end")).toEqual({ terminals: "end", relaunch: false });
  });
});
