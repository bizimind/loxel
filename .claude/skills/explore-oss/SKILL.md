---
name: explore-oss
description: >-
  Explore locally cloned open source package internals in ~/git/open-source/.
  Use when checking a dependency's internal API, types, behavior, feature availability,
  or docs — e.g. "how does convex handle pagination", "what args does excalidraw's
  convertToExcalidrawElements accept", "check if dockview supports custom tab renderers".
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash(npm show *)
  - Bash(rg --hidden *)
---

# Open Source Package Explorer

Locally cloned open source repos at `~/git/open-source/` for exploring dependency internals.

## Available Repos

!`ls -m ~/git/open-source/`

## Finding Packages

npm package names may not match directory names (e.g. `@excalidraw/element` is under `excalidraw`). Use these commands to resolve and locate:

```bash
# 1. Get repo URL from npm registry
REPO_URL=$(npm show <package-name> --json | jq -r '
  .repository // error("no repository field") | (if type == "string" then . else .url end)
  | gsub("^git\\+"; "") | gsub("\\.git$"; "")
  | if test("^[^/]+/[^/]+$") then "https://github.com/" + . end
  | if startswith("github:") then "https://github.com/" + ltrimstr("github:") end
')

# 2. Check if already cloned under a different folder name
rg --hidden --no-ignore -l "$REPO_URL" -g '**/.git/config' ~/git/open-source/ | sed 's|\.git/config$||'

# 3. If not found, suggest cloning
git clone "$REPO_URL" ~/git/open-source/<name>
```

## Explore with an Agent

Use an Explore agent pointed at the package directory. Tests are often the most reliable documentation of behavior.
