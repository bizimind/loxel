# Troubleshooting Reference

Most issues from raw JSON editing are eliminated by using the CLI. These fixes apply to edge cases or diagrams edited outside the CLI.

---

## Text doesn't appear inside shapes

**Cause**: Shape was created without `--text`, or raw JSON is missing the bound text element.

**Fix**: Use `edit` to add text, or recreate the shape with `--text`:

```bash
excalidraw -f d.excalidraw edit my-shape --text "My Text"
```

## Arrows appear disconnected

**Cause**: Arrow was created with `--points` instead of `--from`/`--to`, and points don't align with shape edges.

**Fix**: Delete the arrow and recreate with bindings:

```bash
excalidraw -f d.excalidraw delete arrow-id
excalidraw -f d.excalidraw draw arrow --from source-id --to target-id
```

## Elements overlap or are poorly spaced

**Fix**: Use `move` to reposition, then render to verify:

```bash
excalidraw -f d.excalidraw move my-element --to-x 400 --to-y 200
excalidraw -f d.excalidraw view --scale 2
```

Or shift a group of elements:

```bash
# Move all elements connected to a node
excalidraw -f d.excalidraw query my-node --connected --ids | excalidraw -f d.excalidraw move --dx 200
```

## Deleting a shape leaves orphaned arrows/text

**Cause**: Element was deleted via raw jq instead of the CLI.

**Fix**: The CLI's `delete` command cascades by default — it removes bound text elements and connected arrows. Use it instead of jq for deletion:

```bash
excalidraw -f d.excalidraw delete my-shape
```

To skip cascade: `--no-cascade-arrows` or `--no-cascade-text`.

## Lint reports binding issues

**Fix**: Usually caused by manual JSON edits that broke the bidirectional binding references. The safest fix is to delete and recreate the affected elements via CLI.
