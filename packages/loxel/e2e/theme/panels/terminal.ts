import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PanelShot } from "../lib";

/**
 * Prints a fixed screen of colorful output: a plain prompt, the 16 ANSI colors as text and
 * backgrounds, text styles, the fixture's colored git graph and status, an `ls -G` listing and
 * test-runner style lines, then hands over to a bare interactive bash with the same prompt.
 * `clear` first drops whatever the user's shell profile printed.
 */
const DEMO = String.raw`#!/bin/bash
export GIT_PAGER=cat PAGER=cat
clear
P=$'\e[1;34morbit-shop\e[0m \e[35mmain\e[0m $ '
row() { for c in "$@"; do printf '\e[%sm %-8s\e[0m' "$c" "$c"; done; printf '\n'; }
printf '%secho 16 colors\n' "$P"
row 30 31 32 33 34 35 36 37
row 90 91 92 93 94 95 96 97
row '30;47' '30;41' '30;42' '30;43' '37;44' '37;45' '30;46' '37;40'
row '30;107' '30;101' '30;102' '30;103' '30;104' '30;105' '30;106' '97;100'
printf '\e[1mbold\e[0m  \e[2mdim\e[0m  \e[3mitalic\e[0m  \e[4munderline\e[0m  \e[7minverse\e[0m  \e[9mstrike\e[0m  \e[1;31mbold red\e[0m  \e[2;32mdim green\e[0m\n'
printf '%sgit log --oneline --graph --all\n' "$P"
git -c color.ui=always log --oneline --graph --all --decorate
printf '%sgit status -sb\n' "$P"
git -c color.ui=always status -sb
printf '%sls -G\n' "$P"
CLICOLOR_FORCE=1 ls -G
printf '%sbun test\n' "$P"
printf ' \e[32m✓\e[0m catalog \e[2m> formats prices\e[0m \e[2m[0.42ms]\e[0m\n'
printf ' \e[32m✓\e[0m search \e[2m> matches substrings\e[0m \e[2m[0.18ms]\e[0m\n'
printf ' \e[31m✗\e[0m server \e[2m> returns 404 for unknown ids\e[0m \e[2m[1.07ms]\e[0m\n'
printf '   \e[31merror:\e[0m expect(received).toBe(expected)\n'
printf '   \e[33mwarning:\e[0m 1 snapshot obsolete\n'
printf '\n \e[32m2 pass\e[0m  \e[31m1 fail\e[0m  \e[2mRan 3 tests across 3 files.\e[0m\n'
touch "$1"
PS1="$P" exec env -u PROMPT_COMMAND bash --norc --noprofile -i
`;

/** A terminal panel with deterministic colorful output. */
const shot: PanelShot = {
  description:
    "Terminal panel (xterm.js) with colorful output: a colored prompt, the 16 ANSI foreground colors and background swatches, bold/dim/italic/underline/inverse/strike text, a colored git log graph with branch and tag decorations, git status, an ls -G listing and test results with green passes and red failures, and the (unfocused) cursor at the prompt",
  run: async (ctx) => {
    const assets = resolve(ctx.fixture, "../../assets");
    mkdirSync(assets, { recursive: true });
    const script = resolve(assets, "terminal-demo.sh");
    writeFileSync(script, DEMO);
    const done = resolve(assets, `terminal-demo-${crypto.randomUUID()}.done`);
    await ctx.openTerminal(`bash ${script} ${done}`);
    // The script touches `done` after its last line; then wait for the canvas to stop changing.
    for (let i = 0; i < 200 && !existsSync(done); i++) await ctx.page.waitForTimeout(50);
    if (!existsSync(done)) throw new Error("terminal demo did not finish");
    rmSync(done);
    // A focused cursor blinks on a wall-clock timer; unfocused, xterm draws a steady outline.
    await ctx.page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    const screen = ctx.page.locator(".xterm-screen:visible").first();
    let previous = await screen.screenshot();
    for (let i = 0; i < 20; i++) {
      await ctx.settle();
      const next = await screen.screenshot();
      if (next.equals(previous)) break;
      previous = next;
    }
  },
};
export default shot;
