# PR feedback the babysit-pr scripts act on: from the repository's owners, members and collaborators,
# and from the review bots the repo runs (Claude Code Review and code scanning). Feedback from anyone
# else is listed for the user and never becomes a blocker or a wake-up.
#
# Input: a GraphQL comment or review node with `author { login __typename }` and `authorAssociation`.
def trusted:
  (.authorAssociation | IN("OWNER", "MEMBER", "COLLABORATOR"))
  or (.author.__typename == "Bot" and (.author.login | IN("github-actions", "claude", "github-advanced-security")));
