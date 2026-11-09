---
name: local-code-review
description: Code review a pull request from a local session and report the findings.
---

Provide a code review for the given pull request.

## Rules

- This is a review-only task. You may edit files locally to test hypotheses (e.g., check if a fix compiles, write and run temp tests to verify a suspicion), but never commit or push changes.
- You have internet access for reading, exploring, and research (e.g., checking library docs, fetching API references), but never write to external services or create issues.
- Always launch agents with `run_in_background: false` (foreground). Background agents waste turns polling for completion.
- We only want HIGH SIGNAL issues. False positives erode trust and waste reviewer time — when in doubt, don't flag it.

## Steps

1. Launch a haiku agent to return a list of file paths (not their contents) for all relevant CLAUDE.md files including:
   - The root CLAUDE.md file, if it exists (in this repo it is a symlink to `AGENTS.md`; cite `AGENTS.md` in links)

   - Any CLAUDE.md or AGENTS.md files in directories containing files modified by the pull request

2. Launch a sonnet agent to view the pull request and return a summary of the changes

3. Launch 4 agents in parallel to independently review the changes. Each agent should return the list of issues, where each issue includes a description and the reason it was flagged (e.g. "CLAUDE.md adherence", "bug"). The agents should do the following:

   Agents 1 + 2: CLAUDE.md compliance sonnet agents
   Audit changes for CLAUDE.md compliance in parallel. Note: When evaluating CLAUDE.md compliance for a file, you should only consider CLAUDE.md files that share a file path with the file or parents.

   Agent 3: Opus bug agent (parallel subagent with agent 4)
   Scan for obvious bugs starting from the diff. Read surrounding code when needed to verify whether a change breaks callers, contracts, or assumptions elsewhere. Flag only significant bugs; ignore nitpicks and likely false positives.

   Agent 4: Opus bug agent (parallel subagent with agent 3)
   Look for problems that exist in the introduced code. This could be security issues, incorrect logic, etc. Only look for issues that fall within the changed code.

   **We only want HIGH SIGNAL issues.** Flag issues where:
   - The code will fail to compile or parse (syntax errors, type errors, missing imports, unresolved references)

   - The code will definitely produce wrong results regardless of inputs (clear logic errors)

   - Clear, unambiguous CLAUDE.md violations where you can quote the exact rule being broken

   - Code that feels like a hacky workaround where a simpler, more idiomatic solution likely exists — e.g., reimplementing something a library likely provides, overly complex types when simpler primitives may exist, or convoluted logic that a standard pattern would handle. Flag even if you can't name the exact alternative; explaining why the code smells is enough.

   Do NOT flag:
   - Code style or quality concerns

   - Potential issues that depend on specific inputs or state

   - Subjective suggestions or improvements

   If you are not certain an issue is real, do not flag it. False positives erode trust and waste reviewer time.

   In addition to the above, each subagent should be told the PR title and description. This will help provide context regarding the author's intent.

4. For each issue found in the previous step by agents 3 and 4, launch parallel subagents to validate the issue. These subagents should get the PR title and description along with a description of the issue. The agent's job is to review the issue to validate that the stated issue is truly an issue with high confidence. For example, if an issue such as "variable is not defined" was flagged, the subagent's job would be to validate that is actually true in the code. Another example would be CLAUDE.md issues. The agent should validate that the CLAUDE.md rule that was violated is scoped for this file and is actually violated. Use Opus subagents for bugs and logic issues, and sonnet agents for CLAUDE.md violations.

5. Filter out any issues that were not validated in step 4. This step will give us our list of high signal issues for our review.

6. Report the findings in your response. For each issue give the file and line, a brief description, why it was flagged (e.g. "bug", or the CLAUDE.md rule it breaks, quoted), and a suggested fix. If no issues were found, state: "No issues found. Checked for bugs and CLAUDE.md compliance."

Use this list when evaluating issues in Steps 3 and 4 (these are false positives, do NOT flag):

- Pre-existing issues

- Something that appears to be a bug but is actually correct

- Pedantic nitpicks that a senior engineer would not flag

- Issues that a linter/formatter/type checker will catch (do not run to verify)

- General code quality concerns (e.g., lack of test coverage, general security issues) unless explicitly required in CLAUDE.md

- Issues mentioned in CLAUDE.md but explicitly silenced in the code (e.g., via a lint ignore comment)

Notes:

- Use gh CLI to read the pull request. Do not use web fetch.

- Review the PR's current head commit.

- Create a todo list before starting.
