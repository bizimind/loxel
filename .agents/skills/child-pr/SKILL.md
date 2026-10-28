---
name: child-pr
description: Like /quick-pr (a PR in a fresh worktree, handed to a detached Claude session in a new Loxel terminal), but the new worktree is nested under the current one in Loxel's sidebar. Use when the user says "child pr", "sub-PR", "nest it under this worktree", or when /orchestrate dispatches an agent.
---

# child-pr

Run `/quick-pr` (`.agents/skills/quick-pr/SKILL.md`) step by step, with one change: the new worktree records the current one as its parent (`loxel-parent-wt = <parent's wt-id>`), so Loxel shows it nested under the worktree you run in. Naming, base, prompt, terminal and report are exactly as in `/quick-pr`.

## Before `/quick-pr` step 2: get the parent's id

From the worktree you run in:

```bash
.agents/skills/child-pr/scripts/wt-id.sh   # prints the current worktree's wt-id
```

It gives a worktree that predates metadata its id on first use. It fails with wt's reason when there is nothing to nest under: worktree metadata is off for the repo, or you are not in a worktree.

## In `/quick-pr` step 2: pass the id to `wt add`

```bash
wt add fix/terminal-title-after-rename --meta loxel-parent-wt=<id> -j
```

## When the script fails

Continue with `/quick-pr` unchanged (a flat worktree, no `--meta`) and add a note to your report: the worktree is not nested, with the script's reason. When the reason is that metadata is off, add that `wt init --worktree-metadata on` turns it on, but do not run it yourself: it changes the repo's git config.

## Listing children

`.agents/skills/child-pr/scripts/children.sh` prints the worktrees nested under the current one, one `wt list -j` entry per line.
