# Side-by-Side Diff View Specification

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

**The Rule**: The side with MORE lines scrolls; the side with FEWER lines (or none) pauses.

| Change Type          | Left Lines | Right Lines | Left Behavior                 | Right Behavior                   |
| -------------------- | ---------- | ----------- | ----------------------------- | -------------------------------- |
| Pure insertion (0→3) | 0          | 3           | **Pauses**                    | Scrolls                          |
| Pure deletion (3→0)  | 3          | 0           | Scrolls                       | **Pauses**                       |
| Modification (2→5)   | 2          | 5           | Scrolls first (2 lines)       | Then scrolls (remaining 3 lines) |
| Modification (5→2)   | 5          | 2           | Scrolls first (3 extra lines) | Then both scroll together        |

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

**At the switch point (midpoint crosses 50%):**

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

**Note on "pausing"**: The visual effect of one panel pausing while the other scrolls is achieved through **offset jumps**, not actual pausing. At the transition point (when the change midpoint crosses viewport center), the follower's offset instantly changes. This creates the visual appearance of:

- Before transition: Both panels scrolling together (offset = 0 for this change)
- At transition: Follower "jumps" (offset applied instantly)
- After transition: Both panels scrolling together again (with new offset)

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

## Gutter Connector Visualization

The center gutter shows SVG connectors between corresponding regions:

- **Aligned sections**: No connector (context lines)
- **Insertions**: Trapezoid narrowing from right (full height) to left (thin line)
- **Deletions**: Trapezoid narrowing from left (full height) to right (thin line)
- **Modifications**: Trapezoid connecting regions of different heights

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
  // Calculate when this change's midpoint crosses viewport center
  if (content is on source side):
    transitionScroll = contentMidpoint - viewportCenter
  else:
    // Content on follower - account for accumulated offset
    transitionScroll = contentMidpoint - viewportCenter - totalOffset

  // Apply offset if we've scrolled past the transition point
  if (scrollTop >= transitionScroll):
    totalOffset += (followerPixels - sourcePixels)
```

**Key insights:**

1. **Offset model**: Each change contributes `followerPx - sourcePx` to the total offset
   - Insertions (right-only): positive offset (follower scrolls ahead)
   - Deletions (left-only): negative offset (follower scrolls behind)

2. **Transition point**: The offset is applied when `scrollTop >= transitionScroll`
   - Before transition: `follower = source` (both aligned to previous context)
   - After transition: `follower = source + offset` (both aligned to next context)

3. **Coordinate systems**: When content is on the follower side, we must account for the accumulated offset when calculating where the midpoint appears in the viewport

4. **Symmetry**: The algorithm is symmetric - scrolling left vs right just swaps which side is source/follower

### Key Files

- `src/components/diff/change-regions.ts` - ScrollAlignmentSection type and buildScrollAlignment()
- `src/hooks/useSyncScroll.ts` - Scroll synchronization hook using CSS transforms
- `src/components/diff/DiffGutter.tsx` - SVG connector visualization
