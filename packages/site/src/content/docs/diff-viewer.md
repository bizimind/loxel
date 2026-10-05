---
title: Diff Viewer
description: Split and unified modes, synchronized scrolling, gutter connectors, and intra-line highlights.
order: 9
---

The diff viewer is where you inspect changes — whether that's your working tree, a single commit, or a range between two refs. The standout behavior is synchronized scrolling that keeps context lines aligned across both panels even when the two sides have unequal line counts.

---

## Modes

The toolbar lets you toggle between two layouts.

**Split** (default) shows the old and new versions side by side. Both panels scroll together. Use split when you want to compare the two sides visually.

**Unified** shows a traditional hunk-based diff with `+` and `-` lines interleaved. Use unified when you want a compact, top-to-bottom read of the changes.

---

## Synchronized scrolling

Split view keeps context lines aligned at all times, even across insertions and deletions.

When you scroll past a section where one side has more lines than the other — an insertion, a deletion, or a block replacement — the follower panel visually pauses while you scroll through the imbalance. Once you've scrolled through the extra lines, the follower catches up and both panels are aligned again.

The panel you are actively scrolling never pauses. Only the follower adjusts. The handoff happens exactly when the midpoint of the change section crosses the 50% viewport mark.

> The effect: no matter where you are in the file, the line you're looking at on the left corresponds to the same context on the right. You never lose your place.

---

## Gutter connectors

The gutter between the two panels in split view is filled with bezier curves connecting changed regions. Colors indicate change type: deletions, additions, and modifications each have their own color.

Unchanged regions between hunks are collapsed by default, with 3 lines of context kept visible on each side. Collapsed regions show a squiggly connector labeled "X hidden lines". Click the squiggly connector to expand that region in place.

---

## Intra-line highlights

Within a modified line, the characters that actually changed are highlighted: red on the old side, green on the new side. Granularity adapts to the edit, as in VS Code's diff editor — a fixed typo highlights a single character, a renamed identifier highlights the whole word. This works in both split and unified views.

---

## Syntax highlighting

The diff viewer uses [Shiki](https://shiki.style/) for syntax highlighting. The theme follows your dark/light mode setting: `github-dark` in dark mode, `github-light` in light mode.

---

## Ref combinations

The diff viewer works with any of these ref combinations:

- Working tree vs HEAD
- Working tree vs any commit
- Commit vs commit
- Branch range

To open a diff, select one or more commits in the git graph, then double-click a file in the Changes panel (or right-click it and choose **Open Diff**). See [Git](/docs/git) for how the commit graph and Changes panel work.

---

## Navigation

Move between files with the previous/next file buttons in the toolbar. There are no keyboard shortcuts for diff navigation currently — per-hunk keyboard navigation is planned.

---

## See also

- [Git](/docs/git) — the commit graph and Changes panel that open diffs in the viewer
- [Code Review](/docs/code-review) — anchoring comments to lines in a diff
- [Guide: Reviewing Agent Code](/docs/guide-reviewing-agent-code) — walking a diff and leaving intent-based comments
