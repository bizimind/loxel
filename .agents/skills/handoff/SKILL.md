---
name: handoff
description: >-
  Compact the current conversation into a handoff document for another agent to pick up.
  Use when ending a session, switching contexts, or preparing work for a fresh agent to continue.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Write a handoff document summarizing the current conversation so a fresh agent can continue the work.\
Save to `/tmp/handoff-$(node -e 'process.stdout.write(crypto.randomUUID())').md`.

Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead. If relevant skills are used in the conversation include a "suggested skills" section in the document, which suggests skills that the agent should invoke.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.\
When done copy the file path to the user clipboard with `pbcopy`.
