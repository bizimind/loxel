# Export to PNG

Render `.excalidraw` files to PNG for visual inspection using the `excalidraw` CLI.

## Render to PNG

```bash
excalidraw -f diagram.excalidraw view                     # Default: diagram.png at 2x scale
excalidraw -f diagram.excalidraw view -o preview.png      # Custom output path
excalidraw -f diagram.excalidraw view --scale 3           # Higher resolution (3x)
```

## Focused Rendering via Piping

Pipe element IDs from `query` to `view` to render only a subgraph. Bound text elements are auto-included.

```bash
# Render only elements connected to api-server
excalidraw -f d.excalidraw query api-server --connected --ids | excalidraw -f d.excalidraw view -o api-subgraph.png

# Render only rectangles
excalidraw -f d.excalidraw query --type rectangle --ids | excalidraw -f d.excalidraw view -o shapes-only.png

# Render elements matching a text pattern
excalidraw -f d.excalidraw query --text "Auth*" --ids | excalidraw -f d.excalidraw view -o auth-section.png
```

## Feedback Loop

Always render after making changes to verify the diagram looks correct. Do not rely on coordinates alone.

```bash
# 1. Make changes via CLI (draw, edit, move, batch)
# 2. Render and inspect
excalidraw -f diagram.excalidraw view --scale 2
# 3. Read the PNG to visually verify
# 4. Fix issues, re-render, repeat
```

## Output

- **Location:** PNG is saved alongside the `.excalidraw` file by default
- **Testing:** Open `.excalidraw` in https://excalidraw.com or the VS Code Excalidraw extension for interactive editing
