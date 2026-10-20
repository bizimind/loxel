---
title: Diff Viewer
description: Split and unified modes, synchronized scrolling, gutter connectors, intra-line highlights, and comparing any two files.
order: 9
---

The diff viewer is where you inspect changes — whether that's your working tree, a single commit, a range between two refs, or two files you pick. The standout behavior is synchronized scrolling that keeps context lines aligned across both panels even when the two sides have unequal line counts.

---

## Modes

The toolbar lets you toggle between two layouts.

**Split** (default) shows the old and new versions side by side. Both panels scroll together. Use split when you want to compare the two sides visually.

**Unified** shows a traditional hunk-based diff with `+` and `-` lines interleaved. Use unified when you want a compact, top-to-bottom read of the changes.

---

## Synchronized scrolling

Split view keeps context lines aligned at all times, even across insertions and deletions.

When you scroll past a section where one side has more lines than the other — an insertion, a deletion, or a block replacement — the follower panel visually pauses while you scroll through the imbalance. Once you've scrolled through the extra lines, the follower catches up and both panels are aligned again.

The panel you are actively scrolling never pauses. Only the follower adjusts, catching up as the middle of the changed section passes the middle of the view.

> The effect: no matter where you are in the file, the line you're looking at on the left corresponds to the same context on the right. You never lose your place.

---

## Gutter connectors

The gutter between the two panels in split view is filled with curved connectors linking changed regions. Colors indicate change type: deletions, additions, and modifications each have their own color.

Unchanged regions between hunks are collapsed by default, with 3 lines of context kept visible on each side. Collapsed regions show a squiggly connector labeled "X hidden lines". Click the squiggly connector to expand that region in place.

---

## Intra-line highlights

Within a modified line, the characters that actually changed are highlighted: red on the old side, green on the new side. Granularity adapts to the edit, as in VS Code's diff editor — a fixed typo highlights a single character, a renamed identifier highlights the whole word. This works in both split and unified views.

---

## Syntax highlighting

Code in the diff viewer is syntax-highlighted with GitHub's color themes, following your dark/light mode setting.

---

## What you can compare

The diff viewer can compare:

- Working tree vs HEAD
- Working tree vs any commit
- Commit vs commit
- Branch range
- Any two files (see [Comparing two files](#comparing-two-files))

To open a diff, select one or more commits in the commit graph, then double-click a file in the Changes panel (or right-click it and choose **Open Diff**). See [Git](/docs/git) for how the commit graph and Changes panel work.

---

## Comparing two files

To compare two files, click the first one in Project Files, then right-click the second and choose **Compare Files**. The file you clicked first opens on the left, the one you right-clicked on the right. Any two text files can be compared, including files in Others folders and drafts.

The comparison opens in its own tab with the same split and unified views, synchronized scrolling, and highlights as any other diff. You can open as many comparisons as you like, alongside the diff of your git changes.

- **Edit both sides in place.** In split view, type in either file. Changes save automatically like in an editor tab, and **Cmd+S** saves right away. The unified view is read-only.
- **Live updates.** The comparison updates as you type and whenever either file changes on disk, for example when an agent edits it. Expanded unchanged regions stay expanded while you edit.
- **Same file in a tab.** If a compared file is also open in an editor tab, edits in one show up in the other once saved.
- **Conflicts and deleted files.** If a file changes on disk while you have unsaved edits to it, a banner above the comparison names the file and lets you accept the disk version or keep yours. A comparison stays on the paths it was opened with: if a compared file is deleted, renamed or moved, a banner offers to re-create it.

Comparisons have no previous/next file navigation and no review comments.

---

## Navigation

In a diff of git changes, move between files with the previous/next file buttons in the toolbar. They step through the files in the order the Changes panel lists them. Diff navigation has no keyboard shortcuts.

---

## See also

- [Git](/docs/git) — the commit graph and Changes panel that open diffs in the viewer
- [Editor](/docs/editor) — the file tree, where comparisons start, and how autosave and conflicts work
- [Code Review](/docs/code-review) — anchoring comments to lines in a diff
- [Guide: Reviewing Agent Code](/docs/guide-reviewing-agent-code) — walking a diff and leaving intent-based comments
