# Agent skills for Loxel users

Skills you can install in your own coding agent (Claude Code, or any agent that supports skills) to use Loxel's tools. Each folder is a self-contained skill: copy it, or symlink it from a clone of this repository, into your agent's skills directory, such as `~/.claude/skills/<name>` for Claude Code. The [Loxel docs](https://bizimind.io/docs/terminals#teach-your-agent-about-loxel) have the install commands.

- [`loxel`](loxel/SKILL.md) — working inside the Loxel IDE: opening files, folders and URLs in Loxel and starting commands or agents in new terminal panels with the `loxel` CLI

The skills this repository's own agents use while working on it live in `.agents/skills/`.
