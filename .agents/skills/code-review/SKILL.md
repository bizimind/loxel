---
description: Code review a pull request
---

Provide a code review for the given pull request.

## Rules

- This is a review-only task. You may edit files locally to test hypotheses (e.g., check if a fix compiles, write and run temp tests to verify a suspicion), but never commit or push changes.
- You have internet access for reading, exploring, and research (e.g., checking library docs, fetching API references) and for posting review comments to the PR — but never write to external services, create issues, or post anywhere other than the PR under review.
- Always launch agents with `run_in_background: false` (foreground). Background agents waste turns polling for completion.
- We only want HIGH SIGNAL issues. False positives erode trust and waste reviewer time — when in doubt, don't flag it.

## Steps

1. Check for prior Claude review comments on this PR. Run:

   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr_number}/comments --jq '.[] | select(.user.login == "claude[bot]") | {id, path, line, original_commit_id, created_at, body}'
   ```

   If prior comments exist, this is a **re-review**. Determine the interdiff — the set of changes between the last review and the current PR head:
   - Find the `original_commit_id` of the most recent prior review comment (this is the commit that was actually reviewed — note: `commit_id` gets re-pointed to the current PR head by GitHub, so always use `original_commit_id`).
   - Get the current PR head: `gh pr view {pr_number} --json headRefOid --jq .headRefOid`
   - Fetch the old commit into the shallow clone: `git fetch origin <original_commit_id>`
   - Run `git diff <original_commit_id>..<pr_head_sha>` to get only the changes since the last review. Do NOT diff against `HEAD` — in a `pull_request` workflow, `HEAD` is the merge ref, not the PR tip.
   - Pass both the prior comments and the interdiff to the review agents in step 4 so they can:
     - Skip issues that were already flagged and haven't changed
     - Check whether previously flagged issues were addressed
     - Focus review effort on new and changed code
   - **Fallback**: if the interdiff cannot be computed (e.g., fetch fails, empty diff, or any error), fall back to reviewing the full PR diff as if this were a first review. Do not skip the review.

   If no prior comments exist, this is a **first review** — proceed normally with the full diff.

2. Launch a haiku agent to return a list of file paths (not their contents) for all relevant CLAUDE.md files including:
   - The root CLAUDE.md file, if it exists

   - Any CLAUDE.md files in directories containing files modified by the pull request

3. Launch a sonnet agent to view the pull request and return a summary of the changes

4. Launch 4 agents in parallel to independently review the changes. If step 1 identified this as a **re-review**, provide each agent with the prior comments and interdiff so they focus on new/changed code and skip already-flagged issues that haven't changed. Each agent should return the list of issues, where each issue includes a description and the reason it was flagged (e.g. "CLAUDE.md adherence", "bug"). The agents should do the following:

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

5. For each issue found in the previous step by agents 3 and 4, launch parallel subagents to validate the issue. These subagents should get the PR title and description along with a description of the issue. The agent's job is to review the issue to validate that the stated issue is truly an issue with high confidence. For example, if an issue such as "variable is not defined" was flagged, the subagent's job would be to validate that is actually true in the code. Another example would be CLAUDE.md issues. The agent should validate that the CLAUDE.md rule that was violated is scoped for this file and is actually violated. Use Opus subagents for bugs and logic issues, and sonnet agents for CLAUDE.md violations.

6. Filter out any issues that were not validated in step 5. This step will give us our list of high signal issues for our review.

7. Output a summary of the review findings in your response:
   - If issues were found, list each issue with a brief description.

   - If no issues were found, state: "No issues found. Checked for bugs and CLAUDE.md compliance."

   If NO issues were found, post a summary comment using `gh pr comment` and stop.

   If issues were found, continue to step 8.

8. Create a list of all comments that you plan on leaving. This is only for you to make sure you are comfortable with the comments. Do not post this list anywhere.

9. Post inline comments for each issue using `gh api`. Use this exact syntax:

   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr_number}/comments \
     -f body='comment text' \
     -f commit_id='full_sha' \
     -f path='relative/file/path' \
     -F line=42 \
     -f side='RIGHT'
   ```

   For multi-line comments, add `-F start_line=38` to mark the range start.

   For each comment:
   - Provide a brief description of the issue

   - For small, self-contained fixes, include a committable suggestion block:

     ````
     ```suggestion
     replacement code here
     ```
     ````

   - For larger fixes (6+ lines, structural changes, or changes spanning multiple locations), describe the issue and suggested fix without a suggestion block

   - Never post a committable suggestion UNLESS committing the suggestion fixes the issue entirely. If follow up steps are required, do not leave a committable suggestion.

   **IMPORTANT: Only post ONE comment per unique issue. Do not post duplicate comments.**

Use this list when evaluating issues in Steps 4 and 5 (these are false positives, do NOT flag):

- Pre-existing issues

- Something that appears to be a bug but is actually correct

- Pedantic nitpicks that a senior engineer would not flag

- Issues that a linter/formatter/type checker will catch (do not run to verify)

- General code quality concerns (e.g., lack of test coverage, general security issues) unless explicitly required in CLAUDE.md

- Issues mentioned in CLAUDE.md but explicitly silenced in the code (e.g., via a lint ignore comment)

Notes:

- Use gh CLI to interact with GitHub (e.g., fetch pull requests, create comments). Do not use web fetch.

- Create a todo list before starting.

- You must cite and link each issue in inline comments (e.g., if referring to a CLAUDE.md, include a link to it).

- If no issues are found, post a comment with the following format:

---

## Code review

No issues found. Checked for bugs and CLAUDE.md compliance.

---

- When linking to code in inline comments, follow the following format precisely, otherwise the Markdown preview won't render correctly: [https://github.com/\<owner>/\<repo>/blob/\<full-commit-hash>/\<file-path>#L10-L15](https://github.com/anthropics/claude-code/blob/c21d3c10bc8e898b7ac1a2d745bdc9bc4e423afe/package.json#L10-L15)
  - Requires full git sha. Commands like `https://github.com/owner/repo/blob/$(git rev-parse HEAD)/foo/bar` will not work, since your comment will be directly rendered in Markdown.

  - Repo name must match the repo you're code reviewing

  - `#` sign after the file name

  - Line range format is L\[start]-L\[end]

  - Provide at least 1 line of context before and after, centered on the line you are commenting about (eg. if you are commenting about lines 5-6, you should link to `L4-7`)
