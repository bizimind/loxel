# Authors whose PR feedback the babysit-pr and fix-pr-comments scripts act on: the repository's
# owners, members and collaborators, plus the review bots the repo runs (Claude Code Review and code
# scanning). Comments from anyone else are listed as outside feedback for the user and never become
# work items.
#
# Input: a GraphQL comment or review node with `author { login __typename }` and `authorAssociation`.
def trusted_bots: ["github-actions", "claude", "github-advanced-security"];
def trusted:
  (.authorAssociation | IN("OWNER", "MEMBER", "COLLABORATOR"))
  or (.author.__typename == "Bot" and (.author.login | IN(trusted_bots[])));
