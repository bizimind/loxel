#!/usr/bin/env bash
# List lines in the repo's docs that mention what this branch changed, so stale docs get fixed in
# the same PR (see "Documentation" in AGENTS.md).
#
#   scripts/docs-sweep.sh [base]    compare HEAD and uncommitted changes with base (default origin/main)
#
# Terms are the names of changed files, plus the compound identifiers whose definitions or type
# properties the diff adds or removes. Removed terms come first: a doc that still names them is
# stale. Every tracked Markdown file is searched; review each hit.
set -euo pipefail

base="${1:-origin/main}"
cd "$(git rev-parse --show-toplevel)"
diff="$(git diff "$(git merge-base "$base" HEAD)" -- . ':(exclude)*.md' ':(exclude)*.mdx' ':(exclude)pnpm-lock.yaml')"

# Definitions and type properties on the diff's added (+) or removed (-) lines. Only compound names
# (camelCase, PascalCase, snake_case) are kept: plain words like "error" match docs everywhere.
definitions() {
  grep -E "^\\$1" <<<"$diff" | grep -vE "^\\$1\\$1\\$1" | cut -c2- |
    grep -oE '^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|const|let)\s+[A-Za-z_$][A-Za-z0-9_$]+|^\s+(readonly\s+)?[A-Za-z_][A-Za-z0-9_]+\??:' |
    grep -oE '[A-Za-z_$][A-Za-z0-9_$]+\??:?$' | tr -d '?:' |
    grep -E '[a-z][A-Z]|[A-Za-z]_[A-Za-z]' | sort -u || true
}
added="$(definitions +)"
removed="$(definitions -)"
files="$(git diff --name-only "$(git merge-base "$base" HEAD)" -- . ':(exclude)*.md' ':(exclude)*.mdx' |
  sed -E 's#.*/##; s/\.[^.]+$//' | grep -E '^.{4,}$' | grep -vxE 'index|types|package|README' | sort -u || true)"

report() {
  local label="$1" terms="$2" term hits
  [[ -n "$terms" ]] || return 0
  while IFS= read -r term; do
    hits="$(git grep -n -w -F -e "$term" -- '*.md' '*.mdx' || true)"
    [[ -n "$hits" ]] || continue
    count="$(wc -l <<<"$hits" | tr -d ' ')"
    # A common word (server, routes) matches everywhere; list it as a count only.
    if (( count > 25 )); then
      echo "== $term ($label): $count lines, too common to list; search for it in context if it matters"
      continue
    fi
    echo "== $term ($label)"
    cut -c1-200 <<<"$hits"
  done <<<"$terms"
}

report "removed" "$(comm -13 <(echo "$added") <(echo "$removed"))"
report "file changed" "$files"
report "added or changed" "$added"
