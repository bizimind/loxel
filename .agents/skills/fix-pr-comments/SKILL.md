---
name: fix-pr-comments
description: Address review comments on a pull request by verifying each one, fixing the valid ones, and replying on and resolving every thread. Use when asked to fix or address PR comments or review findings, or when /babysit-pr hits review threads.
---

Address the review comments on this PR.

1. Read every unresolved review thread, top-level review body and PR-level comment.
2. Check each one against the current code, then decide for yourself; don't stop to ask:
   - Bugs or security issues this PR introduced: always fix them.
   - Architecture or design gaps: rework the problematic part instead of patching around it, unless that goes against an intentional design decision.
   - Requests that would roughly double an already big PR: defer them to a new issue for a follow-up PR.
   - Nits that are opinion rather than a concrete gap, typical of late rounds on a big PR: skip them.
3. After pushing, reply on each thread in a sentence or two and resolve it, saying what was fixed (`Fixed in <short sha>: ...`), why it was skipped, or which issue it was deferred to. Security findings never go in a public issue.
4. Summarize your decisions (reworked, deferred, skipped, and why) for the user in a few readable lines, and add them to the PR body.

```bash
# Unresolved threads: threadId, the first comment's id, location and body
gh api graphql -F pr=<pr> -f query='query($pr: Int!) { repository(owner: "bizimind", name: "loxel") {
  pullRequest(number: $pr) { reviewThreads(last: 100) { nodes { id isResolved path line
  comments(first: 1) { nodes { databaseId body } } } } } } }' \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)'

gh api repos/{owner}/{repo}/pulls/<pr>/comments/<databaseId>/replies -f body='Fixed in abc1234: ...'

# Pass the thread id as a variable; inlining it into the query string breaks the GraphQL parse
gh api graphql -f id=<PRRT_ thread id> \
  -f query='mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }'
```
