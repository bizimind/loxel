#!/usr/bin/env bash
# Print the PR feedback to address as JSON: unresolved review threads, review bodies and PR-level
# comments from the project's own people and review bots (babysit-pr/scripts/trusted.jq), and an
# `outside` list (kind, author, url; no text) of feedback from anyone else, for the user to read.
#
#   comments.sh <pr>
set -euo pipefail

pr="${1:?usage: comments.sh <pr>}"
trust_dir="$(cd "$(dirname "$0")/../../babysit-pr/scripts" && pwd)"
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

# shellcheck disable=SC2016 # GraphQL variables, not shell expansions
gh api graphql -F number="$pr" -f owner="${repo%/*}" -f name="${repo#*/}" -f query='
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      reviewThreads(last: 100) { nodes { id isResolved isOutdated path line
        comments(first: 50) { nodes { databaseId url body author { login __typename } authorAssociation } } } }
      reviews(last: 100) { nodes { url state body author { login __typename } authorAssociation } }
      comments(last: 100) { nodes { url body author { login __typename } authorAssociation } } } } }' |
  jq -L "$trust_dir" 'include "trusted";
    def who: .author.login // "ghost";
    .data.repository.pullRequest as $p
    | [$p.reviewThreads.nodes[] | select(.isResolved | not)] as $open
    | [$open[] | select(.comments.nodes[0] | trusted)] as $threads
    | {
        threads: [$threads[] | {threadId: .id, path, line, isOutdated,
          commentId: .comments.nodes[0].databaseId,
          comments: [.comments.nodes[] | select(trusted) | {author: who, body}]}],
        reviews: [$p.reviews.nodes[] | select(trusted and .body != "") | {author: who, state, url, body}],
        comments: [$p.comments.nodes[] | select(trusted) | {author: who, url, body}],
        outside: (
          [$open[] | select(.comments.nodes[0] | trusted | not) | .comments.nodes[0] | {kind: "thread", author: who, url}]
          + [$threads[].comments.nodes[1:][] | select(trusted | not) | {kind: "reply", author: who, url}]
          + [$p.reviews.nodes[] | select((trusted | not) and .body != "") | {kind: "review", author: who, url}]
          + [$p.comments.nodes[] | select(trusted | not) | {kind: "comment", author: who, url}])
      }'
