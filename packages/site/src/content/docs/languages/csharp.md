---
title: C#
description: C# language features from your own csharp-ls, loaded once you trust the repository and restore its projects.
order: 13.5
---

Loxel highlights `.cs` and `.csx` files out of the box. Everything else comes from [csharp-ls](https://github.com/razzmatazz/csharp-language-server), which you install yourself and which runs on your own .NET. Loxel does not bundle or download either one.

## What to install

csharp-ls needs a .NET 10 SDK to install and a .NET 10 runtime to run, whatever version your projects target:

1. Install the [.NET 10 SDK](https://dotnet.microsoft.com/download). It sits next to the SDKs you already have, and projects that pin an older one with `global.json` keep using it. They still need that older SDK installed.
2. In a terminal, outside any repository that pins an older SDK, run `dotnet tool install --global csharp-ls`.

Loxel needs csharp-ls 0.24.0 or newer. To update, run `dotnet tool update --global csharp-ls`. Loxel looks for `csharp-ls` on your `PATH` and in `~/.dotnet/tools`.

A repository that lists csharp-ls in its `.config/dotnet-tools.json` manifest uses that version instead, once you run `dotnet tool restore`.

## What a project needs

Language features start for a repository when all of these are true:

- You [trust the repository](/docs/repository-trust), because loading a C# project runs the repository's build files.
- Its projects are restored: you have run `dotnet restore`, so `project.assets.json` exists. If you accepted the [setup suggestion](/docs/worktrees-and-projects) when adding the project, each new worktree runs it; you can remove that from the setup script.
- .NET and csharp-ls are installed, as above.

A fresh clone therefore gets syntax highlighting only, and a notice tells you the next step: what to install or what to run, or the status bar's **Restricted** item asks about trust. You don't need to restart anything. Language features start by themselves after you trust the repository, install csharp-ls or run `dotnet restore`.

Opening a C# file never restores packages, installs tools or downloads anything, including with a `nuget.config` that names a feed. Trusting a repository doesn't change that.

## What you get

Hover, go-to-definition, references, rename across files, completion, signature help, document and workspace symbols, formatting, code actions and quick fixes, semantic highlighting, inlay hints, and compiler and analyzer diagnostics that follow your `.editorconfig` severities.

Completion lists what is already imported. For a type from a namespace you haven't imported, use the quick fix that adds the `using`.

## Which projects load

- One solution at the repository's root is what loads.
- With several solutions and no single one at the root, csharp-ls loads the first by path and a notice names it. Files outside it get syntax highlighting only.
- With no solution, every project in the repository loads.
- A project in what loads that isn't restored still loads, and a notice names it: references to its packages show as errors until you run `dotnet restore`.
- A project csharp-ls can't load gets a notice naming it, and its files may have fewer features.
- A project using an MSBuild SDK delivered through NuGet, such as `MSTest.Sdk` or `Aspire.AppHost.Sdk`, loads without that SDK, since loading it could download it. A notice names it, and its files show errors.

After a `dotnet restore`, or when `obj` goes away, the server restarts to pick up the change. A large solution takes a little while to load again.

A `.cs` file outside any loaded project, or in a repository with no project at all, gets syntax highlighting only.

## Scope

Go-to-definition reaches your own code. Going into the source of the .NET libraries or NuGet packages isn't supported: hover still shows their signatures and documentation, and definition finds nothing for those symbols.

For format on save with CSharpier, see [Formatter auto-detection](/docs/editor#formatter-auto-detection).
