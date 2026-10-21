---
name: fix-pr-comments
description: Address review comments on a pull request by verifying each one, fixing the valid ones, and replying on and resolving every thread. Use when asked to fix or address PR comments or review findings, or when /babysit-pr hits review threads.
---

Address the review comments on this PR.

1. Read every unresolved review thread, every top-level review body, and every PR-level comment using `gh`. Inline threads are not the only place findings land.
2. Before addressing each comment, verify it's still relevant — the code may have changed since the comment was written
3. If a comment contradicts the current plan or approach, surface the conflict and ask me to decide before making changes
4. Address the remaining comments
5. After pushing, reply on each thread in one or two sentences, then resolve it:
   - Fixed: `Fixed in <short sha>: <what changed>`
   - Declined: why the finding does not apply
   - Out of scope: file a labeled issue and link it. Security findings never go in a public issue: fix them or tell me

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

Answer top-level review bodies and PR-level comments with `gh pr comment <pr> --body '...'`.
