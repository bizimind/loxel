import { selectRandomPrinciples } from "./principles.ts";
import { selectRandomTaskType, TASK_TYPES } from "./task-types.ts";

const customPrompt = process.env.USER_PROMPT || "";
const taskTypeInput = process.env.TASK_TYPE || "";
const principles = selectRandomPrinciples(4);

// Determine task type: use input if provided, otherwise randomize (unless custom prompt)
const taskType = customPrompt
  ? null
  : taskTypeInput
    ? TASK_TYPES.find((t) => t.type === taskTypeInput) || selectRandomTaskType()
    : selectRandomTaskType();

const principlesBlock = principles.map((p, i) => `${i + 1}. ${p}`).join("\n");
const principlesSummary = principles.map((p) => p.split(":")[0].trim()).join(", ");

let prompt: string;

if (customPrompt) {
  prompt = `You are generating a backlog issue for the loxel monorepo.

YOUR TASK:
${customPrompt}

GUIDING PRINCIPLES (apply these in your thinking):
${principlesBlock}

PROCESS:
1. Explore the codebase thoroughly - look at code, tests, patterns, recent changes
2. Generate an issue grounded in specific code you found

CREATE THE ISSUE using \`gh issue create\` with:
- A clear, concise title (prefix with appropriate type like "feat:", "idea:", "chore:", etc.)
- A well-structured markdown body that MUST start with:
  \`\`\`
  **Principles:** ${principlesSummary}

  ---
  \`\`\`
  Then include:
  - Summary (2-3 sentences)
  - Context (why this matters, reference specific code you found)
  - Suggested approach (high-level steps)
  - Acceptance criteria (checkboxes)
- Appropriate label(s)

Execute:
gh issue create --title "..." --body "..." --label "..."`;
} else {
  prompt = `You are generating a backlog issue for the loxel monorepo.

TASK TYPE: ${taskType!.type}
${taskType!.desc}

GUIDING PRINCIPLES (apply these in your thinking):
${principlesBlock}

PROCESS:
1. Explore the codebase thoroughly - look at code, tests, patterns, recent changes
2. Generate a ${taskType!.type} that would genuinely improve this codebase
3. The issue should be completable in 1-3 days of focused work

CREATE THE ISSUE using \`gh issue create\` with:
- A clear, concise title (prefix with "${taskType!.type}:")
- A well-structured markdown body that MUST start with:
  \`\`\`
  **Principles:** ${principlesSummary}

  ---
  \`\`\`
  Then include:
  - Summary (2-3 sentences)
  - Context (why this matters, reference specific code you found)
  - Suggested approach (high-level steps)
  - Acceptance criteria (checkboxes)
- Label: "${taskType!.type}"

Execute:
gh issue create --title "${taskType!.type}: ..." --body "..." --label "${taskType!.type}"`;
}

console.log(prompt);
