# Side-by-Side Diff View Specification

How the side-by-side diff view keeps its two panels aligned while scrolling, highlights intra-line changes, and draws the gutter between the panels.

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

5. **Source side must be the panel under the pointer**: The mapping is not a bijection (the follower can be paused or clamped, and collapsed regions can leave one side with no scroll range at all), so translating from the wrong side produces jumps. Overlays that intercept wheel events outside the panel containers (such as the collapse indicator in `DiffGutter`) call `scrollBy` from `useMonacoSyncScroll` with the side under the pointer, never a fixed side.

### Key Files

- `src/components/diff/change-regions.ts` - ScrollAlignmentSection type and buildScrollAlignment()
- `src/hooks/useMonacoSyncScroll.ts` - Monaco scroll synchronization hook; exposes `scrollBy` for overlays
- `src/components/diff/unchanged-regions.ts` - Collapsible unchanged regions and alignment adjustment for hidden lines
- `src/components/diff/DiffGutter.tsx` - SVG connector and collapse indicator visualization
