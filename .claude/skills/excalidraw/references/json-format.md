# Excalidraw JSON Format Reference

This is a read-only reference for understanding diagram structure. Use the CLI for creating and editing elements — it handles all required properties, bindings, and defaults automatically.

---

## File Structure

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "excalidraw-cli",
  "elements": [],
  "appState": { "gridSize": null, "viewBackgroundColor": "#ffffff" },
  "files": {}
}
```

All diagram content lives in the `.elements` array.

---

## Element Types

| Type        | Key Properties                                     |
| ----------- | -------------------------------------------------- |
| `rectangle` | x, y, width, height, backgroundColor, strokeColor  |
| `ellipse`   | x, y, width, height (same as rectangle)            |
| `diamond`   | x, y, width, height (same as rectangle)            |
| `text`      | text, fontSize, fontFamily, textAlign, containerId |
| `arrow`     | points, startBinding, endBinding, elbowed          |
| `line`      | points                                             |
| `frame`     | x, y, width, height, name                          |

---

## Bound Text (Shape + Text Element)

When the CLI creates a shape with text (`--text "Text"`), it produces two elements:

1. **Shape** with `boundElements: [{ "type": "text", "id": "<text-id>" }]`
2. **Text** with `containerId: "<shape-id>"`, centered inside the shape

This is why `query` shows both the shape and its text element separately, and why cascade delete removes both when you delete the shape.

---

## Arrow Bindings

When the CLI creates a bound arrow (`--from id --to id`), the arrow stores:

- `startBinding: { elementId, focus, gap, fixedPoint }` — attachment to source shape
- `endBinding: { elementId, focus, gap, fixedPoint }` — attachment to target shape

The referenced shapes have the arrow listed in their `boundElements` array. This bidirectional linkage is what makes cascade delete work — deleting a shape also removes its connected arrows.

---

## Common Property Values

| Property        | Values                                              |
| --------------- | --------------------------------------------------- |
| `strokeStyle`   | `"solid"`, `"dashed"`, `"dotted"`                   |
| `fillStyle`     | `"solid"`, `"hachure"`, `"cross-hatch"`, `"zigzag"` |
| `roughness`     | `0` (clean), `1` (artist), `2` (rough)              |
| `fontFamily`    | `5` (hand), `2` (normal), `3` (code)                |
| `textAlign`     | `"left"`, `"center"`, `"right"`                     |
| `verticalAlign` | `"top"`, `"middle"`                                 |
