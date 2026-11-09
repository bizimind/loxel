import { describe, expect, test } from "bun:test";

import { BUILTIN_FILE_ASSOCIATIONS, BUILTIN_LANGUAGE_INDENTATION } from "@/store/settings-store";

import { getFileIconPath } from "./file-icons";
import { getHighlighter } from "./highlighter";
import { resolveLanguage } from "./resolve-language";

function resolve(path: string, content?: string): string | null {
  return resolveLanguage(path, BUILTIN_FILE_ASSOCIATIONS, content);
}

describe("resolveLanguage for .NET projects", () => {
  test.each([
    ["/repo/src/Program.cs", "csharp"],
    ["/repo/scripts/seed.csx", "csharp"],
    ["/repo/build.cake", "csharp"],
    ["/repo/Pages/Index.cshtml", "razor"],
    ["/repo/Components/Counter.razor", "razor"],
    ["/repo/Polly.slnx", "xml"],
    ["/repo/Polly.Core.slnf", "json"],
    ["/repo/.globalconfig", "ini"],
    ["/repo/analysislevelstyle_all.globalconfig", "ini"],
    ["/repo/.csharpierrc", "yaml"],
    ["/repo/.csharpierrc.json", "json"],
    ["/repo/global.json", "json"],
    ["/repo/Directory.Packages.props", "xml"],
    ["/repo/Directory.Build.targets", "xml"],
  ])("%s → %s", (path, language) => {
    expect(resolve(path)).toBe(language);
  });

  test.each([
    "nuget.config",
    "NuGet.Config",
    "NuGet.config",
    "web.config",
    "Web.config",
    "Web.Debug.config",
    "Web.Release.config",
    "App.config",
    "packages.config",
    "applicationHost.config",
    "machine.config",
  ])("%s → xml, in any case", (name) => {
    expect(resolve(`/repo/${name}`)).toBe("xml");
  });

  test("does not treat every .config file as XML", () => {
    expect(resolve("/repo/.config")).toBeNull();
    expect(resolve("/repo/redis.config", "maxmemory 2mb\n")).toBeNull();
  });

  test("still sniffs an XML .config file with an unknown name", () => {
    expect(resolve("/repo/Cov_x64.config", '<?xml version="1.0"?>\n<Config />')).toBe("xml");
  });

  test("leaves .sln files as plaintext: nothing ships a grammar for them", () => {
    expect(resolve("/repo/Polly.sln")).toBeNull();
  });
});

describe("Razor", () => {
  test("has a Shiki grammar loaded", async () => {
    const highlighter = await getHighlighter();
    expect(highlighter.getLoadedLanguages()).toContain("razor");
  });

  test("indents with 4 spaces like C#", () => {
    expect(BUILTIN_LANGUAGE_INDENTATION.get("razor")).toEqual(
      BUILTIN_LANGUAGE_INDENTATION.get("csharp"),
    );
  });
});

describe(".NET project icons", () => {
  test.each([
    ["Program.cs", "cs_dark.svg"],
    ["seed.csx", "cs_dark.svg"],
    ["build.cake", "cs_dark.svg"],
    ["Index.cshtml", "cshtml_dark.svg"],
    ["Counter.razor", "cshtml_dark.svg"],
    ["Polly.csproj", "csproj_dark.svg"],
    ["Polly.sln", "solution_dark.svg"],
    ["Polly.slnx", "solution_dark.svg"],
    ["Polly.Core.slnf", "solution_dark.svg"],
    ["Directory.Build.props", "projectProperties_dark.svg"],
    ["Directory.Build.targets", "projectProperties_dark.svg"],
    ["Directory.Packages.props", "projectProperties_dark.svg"],
    ["nuget.config", "config_dark.svg"],
    ["NuGet.Config", "config_dark.svg"],
    ["global.json", "json_dark.svg"],
    [".csharpierrc", "config_dark.svg"],
    [".globalconfig", "config_dark.svg"],
    ["analysislevelstyle_all.globalconfig", "config_dark.svg"],
  ])("%s → %s", (filename, icon) => {
    expect(getFileIconPath(filename)).toBe(`./icons/${icon}`);
  });
});
