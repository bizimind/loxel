import type { Locator, Page } from "@playwright/test";

import type { PanelShot } from "../lib";

/** Open the bell popover; a click right after the terminal grabs focus can be swallowed, so retry. */
async function openBell(page: Page, bell: Locator): Promise<Locator> {
  const header = page.getByRole("menu").getByText("Notifications", { exact: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    await bell.click();
    try {
      await header.waitFor({ state: "visible", timeout: 2000 });
      return header;
    } catch {
      // Not open yet; click again.
    }
  }
  throw new Error("notification popover did not open");
}

/**
 * The notification bell popover listing terminal notifications sent with OSC 9, OSC 777 and
 * OSC 99 (high urgency). Notifications live on the server, so earlier ones are cleared first.
 */
const shot: PanelShot = {
  description:
    "Notification bell popover (top-right) listing three terminal notifications with urgency bars (blue normal, orange high), titles, bodies and source/time lines, over a terminal panel",
  run: async ({ page, openTerminal, settle }) => {
    const bell = page.locator("button:has(svg.lucide-bell)").first();
    const menu = page.getByRole("menu");
    // With the terminal attached the notification list has synced, so clearing removes them all.
    await openTerminal();
    await openBell(page, bell);
    const clearAll = menu.getByRole("button", { name: "Clear all" });
    if (await clearAll.isVisible()) {
      await clearAll.click();
      await menu.getByText("No notifications").waitFor({ state: "visible" });
    }
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });

    await page.locator(".xterm-screen:visible").first().click();
    // No backslashes on the command line: zsh title hooks (oh-my-zsh) echo the command through
    // `print -P`, which would turn literal \e escapes into real OSC sequences and duplicate them.
    const osc = (body: string) => `awk 'BEGIN{printf "%c]${body}%c", 27, 7}'`;
    await page.keyboard.type(
      [
        "clear",
        osc("9;Tests passed: 128 of 128"),
        "sleep 0.2",
        osc("777;notify;Build finished;orbit-shop bundled in 2.4s"),
        "sleep 0.2",
        osc("99;e=2:p=title;Deploy needs approval"),
      ].join("; ") + "\n",
    );

    // The three sequences arrive one by one; reopen until the popover lists all of them.
    const expected = ["Deploy needs approval", "Build finished", "Tests passed: 128 of 128"];
    for (let attempt = 0; ; attempt++) {
      // Notifications are stamped with the server's real clock; align the page clock with it
      // before each render so relative times read "a few seconds ago", not the fixed date's gap.
      await page.clock.setFixedTime(new Date(Date.now() + 3000));
      await openBell(page, bell);
      const shown = await Promise.all(
        expected.map((t) => menu.getByText(t, { exact: true }).first().isVisible()),
      );
      if (shown.every(Boolean)) break;
      if (attempt >= 10) throw new Error(`missing notifications: ${JSON.stringify(shown)}`);
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
    }
    await settle();
  },
};
export default shot;
