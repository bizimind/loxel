# Validation Reference

## Lint Command

Run `excalidraw -f <file> lint` to check for structural issues:

- **Binding integrity** — `boundElements` <-> `containerId` references match
- **Arrow connections** — binding references exist, endpoints near shape edges
- **Elbow properties** — multi-point arrows have `elbowed: true`, `roundness: null`
- **Duplicate IDs** — all element IDs are unique
- **Bounding boxes** — arrow `width`/`height` contain all points

```bash
excalidraw -f diagram.excalidraw lint
# No potential issues found.

excalidraw -f diagram.excalidraw lint -j    # JSON output for programmatic use
```

## Query for Verification

Use `query` to quickly review diagram state:

```bash
# Overview of all elements
excalidraw -f diagram.excalidraw query

# Check specific elements exist
excalidraw -f diagram.excalidraw query api-server database cache

# Verify connectivity
excalidraw -f diagram.excalidraw query api-server --connected

# Count elements by type
excalidraw -f diagram.excalidraw query --type rectangle
excalidraw -f diagram.excalidraw query --type arrow
```

## Visual Verification

Always render and inspect the PNG — coordinates and structural correctness don't guarantee the diagram looks right:

```bash
excalidraw -f diagram.excalidraw view --scale 2
# Read the PNG to check layout, spacing, readability
```
