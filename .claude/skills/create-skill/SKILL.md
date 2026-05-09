---
name: create-skill
description: Create or improve a Claude Code skill (SKILL.md). Use when building a new skill, reviewing an existing skill for quality, or converting a repeated workflow into a reusable skill.
---

Create or improve the skill: $ARGUMENTS

## Philosophy

A skill sets the tone for a good completion — it doesn't teach Claude things it already knows. Every line must justify its token cost. If Claude would do it correctly without being told, cut it.

Research: LLM reasoning degrades at \~3,000 input tokens. A well-structured 16K prompt outperforms a monolithic 128K one. Recency bias causes early instructions to be undervalued. Conciseness isn't aesthetic — it's performance.

## Before Writing

1. **Run the task without a skill first.** Note where Claude fails or produces generic output. Those gaps — and only those — are what the skill should address.
2. Identify 2-3 concrete use cases from real work, not hypothetical ones
3. Write the description first. If you can't say when it applies in one sentence, it's too broad
4. Decide invocation style: default (both), `disable-model-invocation: true` (user-only, for side effects), or `user-invocable: false` (claude-only, for background knowledge)

## Description

The description is everything. Claude routes to skills through pure language reasoning — no embeddings, no classifiers.

Measured activation rates by description quality:

| Description Quality | Activation Rate |
| ------------------- | --------------- |
| Unoptimized         | \~20%           |
| Optimized           | \~50%           |
| With usage examples | 72-90%          |

Rules:

- Third person: "Generates migration files" not "I help you generate migrations"

- Two parts: what it does + when to use it

- Front-load the key use case — capped at 250 chars

- Match the user's natural language, not formal abstractions

**Good:**

```yaml
description: Generate architecture diagrams as .excalidraw files from codebase analysis. Use when the user asks to create architecture diagrams, system diagrams, visualize codebase structure, or describe flows visually.
```

**Bad:**

```yaml
description: Helps with diagrams
```

## Content: Show, Don't Lecture

**Examples beat rules.** One input/output pair communicates more per token than a paragraph of prose. Examples should outweigh rules in the skill.

**Bad** (\~150 tokens, teaches Claude what it already knows):

```markdown
## Extract PDF text

PDF (Portable Document Format) files are a common file format that contains
text, images, and other content. To extract text from a PDF, you'll need to
use a library. There are many libraries available for PDF processing, but
pdfplumber is recommended because it's easy to use...
```

**Good** (\~50 tokens, provides the non-obvious choice):

````markdown
## Extract PDF text

Use pdfplumber for text extraction:

```python
import pdfplumber
with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```
````

State intent and constraints, not implementation steps. "Return consistent error formats with status codes" beats "You must always check if the response object has a status field and if it does then..."

Use positive framing. "Use named exports exclusively" over "Do NOT use default exports." Models process affirmative statements more reliably.

State what the skill _doesn't_ do — this prevents inappropriate activation and scope creep.

## Calibrate Freedom Per Step

Not every step in a skill needs the same level of prescription. Match constraint strength to the step's fragility:

| Freedom                               | When                                         | Example                                       |
| ------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| **Low** — exact command, no variation | Fragile, error-prone, consistency critical   | `python scripts/migrate.py --verify --backup` |
| **Medium** — pattern with parameters  | Preferred approach exists, some variation ok | "Use this template, customize as needed"      |
| **High** — text guidelines            | Multiple valid approaches, context-dependent | "Review for bugs, edge cases, readability"    |

Skills drift when steps lack quality criteria, not when they lack procedural detail. For judgment-dependent steps, specify the evaluation axes: "Evaluate cost, integration ease, and learning curve; recommend highest scorer" — not "Recommend the optimal tool."

## Structure

Keep SKILL.md under 500 lines. Move detailed reference material to `references/` — Claude loads it on demand. Reference files should be one level deep from SKILL.md (no chains).

```
skill-name/
├── SKILL.md              # Core instructions
├── references/           # Loaded on demand
│   └── examples.md
└── scripts/              # Executed, not loaded into context
    └── validate.sh
```

## Checklist

- [ ] Description: third person, front-loaded use case, specific trigger terms

- [ ] Content: only what Claude can't infer from code or training

- [ ] Examples outweigh rules

- [ ] Freedom level calibrated per step — tight where fragile, loose where judgment matters

- [ ] Boundaries defined — what this skill doesn't cover

- [ ] No generic advice, no lectures on concepts Claude already knows

- [ ] Tested: does it activate when expected? Does output meaningfully differ from without the skill?
