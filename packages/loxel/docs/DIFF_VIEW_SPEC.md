# Side-by-Side Diff View Specification

How the diff views are put together for git diffs and file comparisons, and how the side-by-side view keeps its two panels aligned while scrolling, highlights intra-line changes, and draws the gutter between the panels.

## Components and Data Sources

The views are independent of where their content comes from. [SideBySideDiffView.tsx](../src/components/diff/SideBySideDiffView.tsx) takes the hunks plus, for each side (`DiffSide`), the full lines, a label, the Monaco language and model URI, optional diagnostics and an optional `editable` handle, and renders the two editors, line numbers, gutter and collapsed regions described below. [HunkBasedDiffView.tsx](../src/components/diff-viewer/HunkBasedDiffView.tsx) renders the same hunks unified or as a split table; it reads hidden gap lines through an optional `loadContextLines` callback and resets expanded gaps when that callback changes identity; without one (a patch) it offers no gaps. [DiffToolbar.tsx](../src/components/diff-viewer/DiffToolbar.tsx) (file navigation when a diff has several files, and the split/unified toggle `DiffViewModeToggle`, a global setting) and [FileDiffHeader.tsx](../src/components/diff-viewer/FileDiffHeader.tsx) are shared as well. `HunkSection` (one hunk with its header row, stateless) and `DiffViewModeToggle` also render the markdown editor's [diff blocks](EDITOR.md#diff-blocks) as static markup.

Three kinds of panel feed them:

- **Git diffs.** [DiffViewerPanel.tsx](../src/components/diff-viewer/DiffViewerPanel.tsx) takes a `DiffViewerSource`, a union handled exhaustively: `git` or `patch` (below). The `diff` panel, one per worktree, is the `git` source: it shows the diff source selected in the Changes panel and graph, with hunks from the server ([GIT.md](GIT.md)). In split mode with a commit or worktree context, [GitSideBySideDiffView.tsx](../src/components/diff-viewer/GitSideBySideDiffView.tsx) loads both versions from git or the working tree, fetches TypeScript diagnostics, and turns on review comments (`comments`, see [CODE_REVIEW.md](CODE_REVIEW.md)); without comments the view never touches the comment store. Its read-only models use `loxel://<ref or HEAD>/<repo-relative path>#<old|new>`. Gap lines come from `GET /api/file-lines` at the diff's commit.
- **The working tree in a git diff.** When the new side is the working-tree file itself (an `uncommitted` diff of the active worktree, for any file but a deleted one), `GitSideBySideDiffView` renders it editable instead. The diff viewer has no panel worktree of its own, so the view provides the active worktree as its `PanelContext`, through which the side reads and saves. A file deleted while its side is open (its editor-state entry exists) stays editable, like an editor tab, with the deleted banner and its unsaved text; the side is unmounted, flushing a pending save as a closing tab does, when the split view goes (another file or source, unified mode). The side is a `useEditableSide` keyed `working-tree:<abs path>:new` (`workingTreeSideKey`, which the diff viewer's tab, [diff-tab.tsx](../src/components/dockview/diff-tab.tsx), reads for its conflict and deleted styling), with model `loxel://working-tree/<abs path>#new`; the old side stays a read-only git model. The hunks are computed on the client from the old side and the live text, as in a comparison (below), so the coloring follows each edit; the server's hunks still drive the unified view, the file header's counts and the Changes panel, and can differ slightly from the client's. Both sides' lines are split on `\n` only (`splitGitLines`), as the server reads files for comment placement, so a CRLF file's lines keep their `\r` and comment anchors made from them match the server's. The diff runs on copies without the `\r` (`withoutCarriageReturns`), since `git show` applies no EOL conversion and a file checked out with CRLF (`eol=crlf`, `core.autocrlf`) would otherwise differ on every line; an added file's old side has no lines at all, which `computeFileDiff` diffs as one all-added hunk (Monaco's diff computer requires at least one line per side). A comment composed on the side anchors to lines split (the same way) from its live text rather than the debounced `lines`. Another worktree's uncommitted diff stays read-only: an editable side reads and saves through the active worktree, which would take a file of an unsubscribed worktree as one of its external files. Once the side is edited (its entry turns dirty) the file becomes the worktree's `editedDiffFile` ([worktree-ui.ts](../src/store/worktree-ui.ts)): `useDiffFileSelection` keeps it selected after it leaves the diff, and `GitDiffContent` shows it with no changes (`unchangedFileDiff`) and keeps it in the placed-threads request, so an edit that makes the file match its base does not jump to another file. Selecting any other file, discarding the file from the Changes panel, or the view unmounting (another source, unified mode) releases it; the toolbar then shows no "File N of M" counter, since the file has no place in the list.
- **Patches.** A `patchDiff` panel (`patchdiff-<uuid>`, any number per worktree) is the `patch` source: unified diff text and the file it came from, held in the panel's params (`PatchDiffParams`), so a restored layout shows the same text. It is opened by `openPatchDiff` in [panel-creators.ts](../src/lib/panel-creators.ts), from the markdown editor's [diff blocks](EDITOR.md#diff-blocks), which focuses a panel already holding that text from that file instead of opening another; `patchDiffTitle` names the tab after the patch's one file, or the source file for a multi-file or headerless patch (`<name> patch`). The text is parsed with `parseUnifiedDiff` and rendered by `HunkBasedDiffView` in both modes, split as its two-column table: there are no refs, so no `GitSideBySideDiffView`, no gap expansion, no review comments or placed threads, and no editing. The patch's files keep their order in the text, with their own previous/next state instead of the Changes panel's selection, and a headerless snippet's file is titled "Patch". The panel shows the text it was opened with; editing the block afterwards does not change it.
- **File comparisons.** [CompareFilesPanel.tsx](../src/components/compare/CompareFilesPanel.tsx), any number per worktree (`compare-<uuid>`), compares two files by absolute path. `computeFileDiff` ([compute-file-diff.ts](../src/components/diff/compute-file-diff.ts)) diffs them on the client with the `DefaultLinesDiffComputer` Monaco bundles and emits git-style hunks with three lines of context, so change regions, scroll alignment, collapsing and the unified view work unchanged. Lines are split the way a Monaco model splits them (`splitLines`), so line numbers match the editors. Both sides are editable; each is a `useEditableSide` ([use-editable-side.ts](../src/components/diff/use-editable-side.ts)) holding the side's live text, synced with disk like an editor tab ([EDITOR.md](EDITOR.md#several-editors-of-one-file)), with its conflict and deleted-file banners from [EditableSideBanners.tsx](../src/components/diff/EditableSideBanners.tsx). The diff is recomputed 100 ms (`REDIFF_DELAY_MS`) after either text stops changing, from an edit or from disk, and expanded regions survive the recomputation (below). Models use `loxel://compare/<abs path>#<panel id>-<old|new>`, outside `loxel://HEAD`, so they never count as an editor tab's live model. Gap lines in the unified view come from the new side's text, which the unified view only reads.

An editable side's [EditorPanel.tsx](../src/components/diff/EditorPanel.tsx) starts from the side's text, reports every content change through `onContentChange`, and stops following its `content` prop after mount: its owner applies disk content and merges to the mounted editor as line edits, and keeps the text when no editor is mounted (unified mode), so edits survive switching views. Each `EditorPanel` disposes its model on unmount, so model URIs must be unique among mounted panels.

`useCollapsedRegions` collapses every region again when the hunks change, which suits moving between files. With `keepExpandedOnChange` (views with an editable side) it instead carries expanded regions over with `carryExpandedRegions` ([unchanged-regions.ts](../src/components/diff/unchanged-regions.ts)): a new region stays expanded when it overlaps a previously expanded one on a side whose line count did not change (either side when both or neither changed), since an edit shifts the lines of one side only. Both modes follow the regions during render, so hidden ranges never pair new regions with old indices.

## Synchronized Scrolling Behavior (JetBrains-Style)

### Core Principle

**Keep unchanged (context) lines visually aligned between panels at all times.**

When scrolling through a diff, the viewer maintains alignment of context lines by:

1. Scrolling both panels at the same rate through aligned (unchanged) sections
2. Scrolling panels at **different rates** through changed sections to ensure the next context line aligns when reached

### Section Types

The diff is divided into sections based on line correspondence:

| Section Type     | Left Panel    | Right Panel            | Scroll Behavior                        |
| ---------------- | ------------- | ---------------------- | -------------------------------------- |
| **Aligned**      | Has lines     | Has lines (same count) | Both scroll 1:1 together               |
| **Insertion**    | No content    | New lines added        | Right scrolls; left pauses with marker |
| **Deletion**     | Lines removed | No content             | Left scrolls; right pauses with marker |
| **Modification** | Changed lines | Changed lines          | Both scroll, then extra lines catch up |

---

## Detailed Scrolling Mechanics

### 1. Aligned Sections (Context Lines)

When both panels have the same content:

- Panels scroll together at exactly **1:1 ratio**
- Line N on left aligns with line M on right (where they correspond)
- This is the "rest state" - what the viewer returns to after traversing changes

### 2. Unequal Sections (Insertions, Deletions, Modifications)

**Key Insight**: **Pause and Catch-Up** - one panel pauses while the other scrolls through its lines, then they resume together.

**The Rule**: The side with MORE lines scrolls; the side with FEWER lines (or none) pauses. This describes the visual result; when the panel being scrolled has fewer lines, the other panel jumps instead (see [Source Panel Never Pauses](#source-panel-never-pauses-smooth-scrolling-rule)).

| Change Type          | Left Lines | Right Lines | Left Behavior                    | Right Behavior                   |
| -------------------- | ---------- | ----------- | -------------------------------- | -------------------------------- |
| Pure insertion (0→3) | 0          | 3           | **Pauses**                       | Scrolls                          |
| Pure deletion (3→0)  | 3          | 0           | Scrolls                          | **Pauses**                       |
| Modification (2→5)   | 2          | 5           | Scrolls 2 lines, then **pauses** | Scrolls 2 lines, then 3 more     |
| Modification (5→2)   | 5          | 2           | Scrolls 2 lines, then 3 more     | Scrolls 2 lines, then **pauses** |

**Behavior breakdown**:

- **Insertion (0 left, N right)**: Left panel pauses completely; right scrolls through all N inserted lines
- **Deletion (N left, 0 right)**: Left scrolls through all N deleted lines; right panel pauses completely
- **Modification (unequal counts)**:
  - First, both scroll together for the MIN(left, right) lines (1:1)
  - Then, the side with extra lines continues scrolling while the other pauses

**Result**: When the change section ends, both panels arrive at the next context line **aligned**.

### 3. Insertion/Deletion Marker

When one side has no lines (pure insertion/deletion), that side shows a **thin horizontal marker line** at the position where content exists on the other side. This marker:

- Is the same color/opacity as the change highlight
- Spans the full width of the panel
- Provides visual continuity with the gutter connector

---

## Alignment Switch Point (50% Viewport Rule)

### The Problem

When scrolling through a change section, at what point do we switch from aligning by the PREVIOUS unchanged section to aligning by the NEXT unchanged section?

### The Rule

**Switch alignment when the midpoint of the change section crosses the 50% mark of the viewport.**

This means:

- While the change section's midpoint is BELOW the viewport center (content approaching from bottom) → align by PREVIOUS unchanged lines
- When the change section's midpoint crosses ABOVE the viewport center (content has passed center going up) → switch to aligning by NEXT unchanged lines

As the user scrolls down, content moves up in the viewport. The midpoint "crosses" when it moves from below to above the center line.

### Example: Insertion (2 lines added)

```
Initial state (scrolled to top):
┌─────────────────┐             ┌─────────────────┐
│ 1  unchanged    │ ←──────────→│ 1  unchanged    │  ← aligned (prev context)
│ 2  unchanged    │ ←──────────→│ 2  unchanged    │
│ 3  unchanged    │ ←──────────→│ 3  unchanged    │
│ 4  unchanged    │ ←──────────→│ 4  unchanged    │
│═══════════════  │─────────────│ 5  + added      │  ← change section
│                 │             │ 6  + added      │
│ 5  unchanged    │             │ 7  unchanged    │  ← next context (not yet aligned)
└─────────────────┘             └─────────────────┘
      LEFT                            RIGHT
```

**Scrolling down, BEFORE midpoint crosses 50%:**

- Both panels scroll together (1:1)
- Unchanged lines 1-4 stay aligned
- The insertion section moves up, but hasn't triggered the switch yet

```
Midpoint of insertion approaching 50% viewport mark:
┌─────────────────┐             ┌─────────────────┐
│ 2  unchanged    │ ←──────────→│ 2  unchanged    │  ← still aligned (prev context)
│ 3  unchanged    │ ←──────────→│ 3  unchanged    │
│ 4  unchanged    │ ←──────────→│ 4  unchanged    │
│═══════════════  │─────────────│ 5  + added      │
│ - - - - - - - - │ - - 50% - - │ 6  + added      │  ← midpoint at 50%!
│ 5  unchanged    │             │ 7  unchanged    │
│ 6  unchanged    │             │ 8  unchanged    │
└─────────────────┘             └─────────────────┘
```

**At the switch point (midpoint crosses 50%), with the user scrolling the right panel:**

- Left panel PAUSES
- Right panel continues scrolling to catch up
- Goal: align unchanged line 5 (left) with unchanged line 7 (right)

```
After switch - left paused, right catching up:
┌─────────────────┐             ┌─────────────────┐
│ 3  unchanged    │             │ 4  unchanged    │
│ 4  unchanged    │             │ 5  + added      │
│═══════════════  │─────────────│ 6  + added      │
│                 │      ╲      │ 7  unchanged    │  ← right scrolling faster
│ 5  unchanged    │ ←──────────→│ 7  unchanged    │  ← NOW ALIGNED (next context)
│ 6  unchanged    │ ←──────────→│ 8  unchanged    │
│ 7  unchanged    │ ←──────────→│ 9  unchanged    │
└─────────────────┘             └─────────────────┘
```

If the user scrolls the left panel instead, the left panel keeps moving 1:1 and the right panel jumps ahead by the inserted lines at the switch point (see [Source Panel Never Pauses](#source-panel-never-pauses-smooth-scrolling-rule)).

### Why 50%?

Using the viewport center as the switch point provides:

1. **Smooth visual experience**: The switch happens when the change is centered, feeling natural
2. **Predictable behavior**: Users can anticipate when alignment will shift
3. **Balanced view**: Equal visibility of context before and after the change during transition

---

## Source Panel Never Pauses (Smooth Scrolling Rule)

### The Rule

**The panel being actively scrolled (source) ALWAYS scrolls smoothly at 1:1 with user input. Only the OTHER panel (follower) pauses or jumps to maintain alignment.**

This ensures responsive, predictable scrolling:

- User scrolls right panel → right panel moves exactly as expected, left panel adjusts
- User scrolls left panel → left panel moves exactly as expected, right panel adjusts

### Example

When scrolling the RIGHT panel through an insertion:

```
User scrolls RIGHT panel down:
┌─────────────────┐             ┌─────────────────┐
│ 3  context      │ ← PAUSED    │ 4  context      │ ← SCROLLING (1:1)
│ 4  context      │             │ 5  + added      │
│═══════════════  │─────────────│ 6  + added      │
│                 │             │ 7  context      │
│ 5  context      │             │ 8  context      │
└─────────────────┘             └─────────────────┘
      LEFT (follower)                 RIGHT (source)
```

- RIGHT panel scrolls exactly where the user scrolled (scrollTop)
- LEFT panel pauses at the boundary, then jumps to align when the change passes

### Implementation

```
sourceScroll = scrollTop  // ALWAYS, no exceptions
followerScroll = scrollTop + offset  // Offset changes at transition points
```

How the follower crosses a change depends on which side holds the change's extra lines:

- **Extra lines on the source side**: the follower genuinely pauses. From the transition point (the change midpoint crossing the viewport center) it holds still while the source scrolls through the extra lines, then both continue together.
- **Extra lines on the follower side**: the follower cannot pause backwards, so at the transition point its offset is applied at once and it jumps ahead by the extra lines.

Before and after a change both panels scroll together, aligned to the previous and the next context respectively.

---

## Visual Examples

### Pure Insertion

```
Left Panel (a.txt)              Right Panel (b.txt)
┌─────────────────┐             ┌─────────────────┐
│ 1  context      │ ←──────────→│ 1  context      │  aligned
│ 2  context      │ ←──────────→│ 2  context      │  aligned
│═══════════════  │─────────────│ 3  + new line   │  left: PAUSED (marker)
│                 │      ╲      │ 4  + new line   │  right: scrolling
│ 3  context      │ ←──────────→│ 5  context      │  aligned again
│ 4  context      │ ←──────────→│ 6  context      │  aligned
└─────────────────┘             └─────────────────┘
```

When scrolling down through the insertion:

1. **Start**: Line 2 (left) aligned with line 2 (right) at viewport top
2. **During**: Left PAUSES at marker; right scrolls through lines 3-4
3. **End**: Line 3 (left) aligned with line 5 (right) at viewport top

### Modification (2 lines → 5 lines)

```
Left Panel (a.txt)              Right Panel (b.txt)
┌─────────────────┐             ┌─────────────────┐
│ 1  context      │ ←──────────→│ 1  context      │  aligned
│ 2  ~ modified   │─────────────│ 2  ~ modified   │  both scroll (1:1)
│ 3  ~ modified   │      ╲      │ 3  ~ modified   │  both scroll (1:1)
│                 │       ╲     │ 4  ~ modified   │  left PAUSES
│                 │        ╲    │ 5  ~ modified   │  right catches up
│ 4  context      │ ←──────────→│ 6  context      │  aligned again
└─────────────────┘             └─────────────────┘
```

When scrolling down through the modification:

1. **Start**: Line 1 aligned on both sides
2. **Phase 1**: Both scroll together for 2 lines (the common count)
3. **Phase 2**: Left PAUSES; right scrolls remaining 3 lines
4. **End**: Line 4 (left) aligned with line 6 (right)

---

## Intra-line Highlights

Modified lines keep their whole-line blue background and additionally highlight the characters that changed: red on the old side, green on the new side. For example `const foo = 5` changed to `const bar = 42` marks `foo` and `5` in red and `bar` and `42` in green.

### Granularity

There is no fixed word or character granularity. Each modification block (a run of deleted lines followed by a run of added lines) is diffed at character level and then refined by the heuristics VS Code uses in its own diff editor, which Monaco bundles:

- Short unchanged runs between two edits are merged into one edit, so `foo_bar` to `baz_qux` is one highlight instead of confetti around the `_`.
- An edit covering most of a word extends to the whole word, so `foo` to `bar` highlights the whole identifier.
- Edits covering a small part of a word stay at character level, so `item` to `items` highlights only the `s` and `color` to `colour` only the `u`.
- Edit boundaries slide to token boundaries where the text allows.

### Limits

- Blocks larger than 500 lines on either side are not refined.
- If more than 70% of a block's characters changed on either side, the block gets no inline highlights and renders as a plain modification.
- All blocks of a file share one 200 ms budget. Each block receives only the remaining time, and once the budget is exhausted the remaining blocks get no inline highlights, so a pathological file degrades to plain modifications instead of freezing the frame.
- The hunk-based views compute the pass once per file from the raw hunks, so it does not run again when syntax highlighting resolves.

### Rendering

- Side-by-side (Monaco) view: `inlineClassName` decorations on the text layer, above the whole-line background.
- Hunk-based split and unified views: a transparent copy of the line is positioned under the syntax-highlighted text and carries the highlight spans, so the highlighter's HTML is untouched. Tabs align only when the line content is the first content of its table cell, because the absolutely positioned copy measures tab stops from its own edge; the `+`/`-` markers therefore live in their own cell.

### Key Files

- `src/components/diff/inline-changes.ts` - Adapter over Monaco's `DefaultLinesDiffComputer` producing per-side ranges
- `src/components/diff-viewer/HunkLineContent.tsx` - Ghost-layer renderer for the hunk-based views

---

## Gutter Connector Visualization

The center gutter shows SVG connectors between corresponding regions, drawn as filled bands with curved (Bezier) edges:

- **Aligned sections**: No connector (context lines)
- **Insertions**: Band narrowing from the right region (full height) to a thin line on the left, continued across the left panel by the insertion marker
- **Deletions**: Band narrowing from the left region (full height) to a thin line on the right, continued across the right panel by the deletion marker
- **Modifications**: Band connecting regions of different heights
- **Collapsed unchanged regions**: A wavy line across both panels, with gaps for its labels, joined by a smooth curve through the gutter

---

## Implementation Notes

### Data Structure

```typescript
interface ScrollAlignmentSection {
  type: "aligned" | "left-only" | "right-only";
  leftStartLine: number; // 1-indexed, inclusive
  leftEndLine: number; // 1-indexed, inclusive
  rightStartLine: number; // 1-indexed, inclusive
  rightEndLine: number; // 1-indexed, inclusive
}
```

**Section type meanings**:

- `aligned`: Both panels have lines; scroll together 1:1
- `left-only`: Only left has lines (deletion); left scrolls, right pauses
- `right-only`: Only right has lines (insertion); right scrolls, left pauses

For modifications with unequal line counts, split into:

1. An `aligned` section for MIN(left, right) lines
2. A `left-only` or `right-only` section for the extra lines

### Scroll Translation Algorithm

The algorithm uses an **offset-based model** rather than tracking positions within sections. Each change section contributes an offset that gets applied when the change's midpoint crosses the viewport center.

```
Input: sourceSide ("left" | "right"), scrollTop (pixels), viewportHeight (pixels)
Output: { leftScroll, rightScroll }

sourceScroll = scrollTop  // Source ALWAYS scrolls exactly to scrollTop
followerScroll = scrollTop + totalOffset  // Follower gets offset applied
```

**Building the offset:**

```typescript
totalOffset = 0

for each change section (in top-to-bottom order):
  offset = followerPixels - sourcePixels
  // Calculate when this change's midpoint crosses viewport center
  if (content is on source side):
    transitionScroll = contentMidpoint - viewportCenter
  else:
    // Content on follower - account for accumulated offset
    transitionScroll = contentMidpoint - viewportCenter - totalOffset

  if (offset < 0):
    // Source has the extra lines: pause the follower while the source scrolls through them
    if (transitionScroll <= scrollTop < transitionScroll + |offset|):
      return follower at transitionScroll + totalOffset
    if (scrollTop >= transitionScroll + |offset|):
      totalOffset += offset
  else if (scrollTop >= transitionScroll):
    // Follower has the extra lines: jump
    totalOffset += offset
```

**Key insights:**

1. **Offset model**: Each change contributes `followerPx - sourcePx` to the total offset
   - Change lines on the follower side: positive offset (follower jumps ahead)
   - Change lines on the source side: negative offset (follower pauses, then stays behind)

2. **Transition point**: The change midpoint crossing the viewport center
   - Before transition: the follower keeps the offset of the previous changes (aligned to previous context)
   - After transition (and after the pause zone, for a negative offset): the offset includes this change (aligned to next context)

3. **Coordinate systems**: When content is on the follower side, we must account for the accumulated offset when calculating where the midpoint appears in the viewport

4. **Symmetry**: The algorithm is symmetric - scrolling left vs right just swaps which side is source/follower

5. **Editors scrolling themselves**: Monaco scrolls an editor to reveal the caret when typing in an editable side or moving with the keyboard. `useMonacoSyncScroll` treats a scroll of the focused editor that it did not make itself as the user scrolling that side, and positions the other side from it.

6. **Source side must be the panel under the pointer**: The mapping is not a bijection (the follower can be paused or clamped, and collapsed regions can leave one side with no scroll range at all), so translating from the wrong side produces jumps. Overlays that intercept wheel events outside the panel containers (such as the collapse indicator in `DiffGutter`) call `scrollBy` from `useMonacoSyncScroll` with the side under the pointer, never a fixed side.

### Key Files

- `src/components/diff/change-regions.ts` - ScrollAlignmentSection type and buildScrollAlignment()
- `src/hooks/useMonacoSyncScroll.ts` - Monaco scroll synchronization hook; exposes `scrollBy` for overlays
- `src/components/diff/unchanged-regions.ts` - Collapsible unchanged regions and alignment adjustment for hidden lines
- `src/components/diff/DiffGutter.tsx` - SVG connector and collapse indicator visualization
