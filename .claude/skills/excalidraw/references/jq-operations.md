# jq Operations Reference

Use `jq` for bulk operations that the CLI doesn't cover — recoloring by type, position-based shifts, counting, and complex conditional edits. For single-element operations (create, edit, move, delete), use the CLI instead.

**Always write to a temp file then rename** — `jq ... file > tmp && mv tmp file`.

---

## Bulk Styling

### Recolor all elements of a type

```bash
# Change background of all rectangles
jq '(.elements[] | select(.type == "rectangle")).backgroundColor = "#e3f2fd"' f.excalidraw > tmp && mv tmp f.excalidraw

# Change stroke style to dashed for elements matching a color
jq '(.elements[] | select(.backgroundColor == "#eceff1")).strokeStyle = "dashed"' f.excalidraw > tmp && mv tmp f.excalidraw

# Set all arrows to a consistent color
jq '(.elements[] | select(.type == "arrow")).strokeColor = "#868e96"' f.excalidraw > tmp && mv tmp f.excalidraw
```

---

## Bulk Positioning

### Shift elements by position

```bash
# Shift everything below y=400 down by 200px (make room for new row)
jq '(.elements[] | select(.y >= 400)).y += 200' f.excalidraw > tmp && mv tmp f.excalidraw

# Shift all rectangles 100px right
jq '(.elements[] | select(.type == "rectangle")).x += 100 |
    (.elements[] | select(.type == "rectangle")).y += 50' f.excalidraw > tmp && mv tmp f.excalidraw

# Scale everything (position + size) by 1.5x from origin
jq '.elements |= map(
  .x *= 1.5 | .y *= 1.5 | .width *= 1.5 | .height *= 1.5 |
  if .points then .points |= map([.[0] * 1.5, .[1] * 1.5]) else . end
)' f.excalidraw > tmp && mv tmp f.excalidraw
```

---

## Querying (when CLI query isn't enough)

### Select by position region

```bash
# Elements in a bounding box (x: 100-500, y: 200-600)
jq '.elements | map(select(.x >= 100 and .x <= 500 and .y >= 200 and .y <= 600))' f.excalidraw

# Leftmost / rightmost element
jq '.elements | min_by(.x)' f.excalidraw
jq '.elements | max_by(.x + .width)' f.excalidraw
```

### Select by text content (regex)

```bash
# Find elements containing specific text (regex)
jq '.elements | map(select(.text? // "" | test("Database")))' f.excalidraw

# All bound text and their container IDs
jq -r '.elements[] | select(.containerId != null) | "\(.containerId)\t\(.text)"' f.excalidraw
```

---

## Counting and Summarizing

```bash
# Count elements by type
jq '.elements | group_by(.type) | map({type: .[0].type, count: length})' f.excalidraw

# Total element count
jq '.elements | length' f.excalidraw

# Bounding box of entire diagram
jq '{
  minX: [.elements[].x] | min,
  minY: [.elements[].y] | min,
  maxX: [.elements[] | .x + .width] | max,
  maxY: [.elements[] | .y + .height] | max
}' f.excalidraw
```

---

## Deleting by Condition

```bash
# Remove all elements below y=800
jq '.elements |= map(select(.y < 800))' f.excalidraw > tmp && mv tmp f.excalidraw

# Remove all text elements (strip labels) — prefer CLI delete with piping for most cases
jq '.elements |= map(select(.type != "text"))' f.excalidraw > tmp && mv tmp f.excalidraw
```

---

## Tips

- **Chain operations** with `|` inside jq rather than piping between multiple jq calls.
- **Use `sponge`** from moreutils as an alternative to the tmp file pattern: `jq '...' file | sponge file`.
- **Combine with the CLI** — use jq for bulk queries/edits, CLI for everything else.
