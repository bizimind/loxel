# Arrow Reference

The CLI handles arrow routing automatically — `draw arrow --from id --to id` calculates edge points, bindings, and positions. This reference covers styling options and advanced patterns.

---

## Creating Arrows

### Bound arrows (preferred)

```bash
# Simple connection
excalidraw -f d.excalidraw draw arrow --from api-server --to database

# With text
excalidraw -f d.excalidraw draw arrow --from api-server --to database --text "SQL"

# In batch
{"command":"draw","type":"arrow","from":"api","to":"db","text":"REST"}
```

### Free-floating arrows (manual positioning)

```bash
# Specify start position and points
excalidraw -f d.excalidraw draw arrow -x 100 -y 200 --points '[[0,0],[0,150]]'
```

---

## Arrowhead Options

| Value      | Appearance        |
| ---------- | ----------------- |
| `none`     | No arrowhead      |
| `arrow`    | Standard arrow    |
| `bar`      | Perpendicular bar |
| `dot`      | Filled circle     |
| `triangle` | Filled triangle   |

```bash
# Bidirectional arrow
excalidraw -f d.excalidraw draw arrow --from a --to b --start-head arrow --end-head arrow

# No arrowhead (plain line with binding)
excalidraw -f d.excalidraw draw arrow --from a --to b --end-head none
```

In batch:

```json
{
  "command": "draw",
  "type": "arrow",
  "from": "a",
  "to": "b",
  "startHead": "arrow",
  "endHead": "arrow",
  "text": "bidirectional"
}
```

---

## Arrow Styling

```bash
# Dashed arrow
excalidraw -f d.excalidraw draw arrow --from a --to b --stroke-style dashed --stroke "#868e96"

# Thick arrow
excalidraw -f d.excalidraw draw arrow --from a --to b --stroke-width 4
```

---

## Multiple Arrows from Same Shape

When several arrows leave from the same shape, the CLI automatically calculates distinct edge attachment points via bindings. If arrows visually overlap, try:

1. Connecting to different shapes rather than having multiple arrows between the same pair
2. Using text to distinguish arrow purposes
3. Adjusting shape positions to create more space
