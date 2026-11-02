import { describe, expect, test } from "bun:test";

import type { CSharpLspState, CSharpStatusResponse } from "@/api/csharp-env-model";

import { csharpStatusLabel, csharpStatusTooltip, csharpStatusWarning } from "./csharp-solution";

const WT = "/repo/wt";

function status(
  server: CSharpLspState | null,
  overrides: Partial<CSharpStatusResponse> = {},
): CSharpStatusResponse {
  return { server, chosen: null, chosenMissing: false, ...overrides };
}

const RUNNING: CSharpLspState = {
  kind: "running",
  target: `${WT}/src/All.slnx`,
  projects: [`${WT}/src/App.csproj`],
  sdkVersion: "10.0.403",
};

describe("csharpStatusLabel", () => {
  test("shows nothing without a decision or a project", () => {
    expect(csharpStatusLabel(status(null))).toBeNull();
    expect(csharpStatusLabel(status({ kind: "no-project" }))).toBeNull();
  });

  test("names what loaded", () => {
    expect(csharpStatusLabel(status(RUNNING))).toBe("C#: All.slnx");
    expect(csharpStatusLabel(status({ ...RUNNING, target: null }))).toBe("C#: App.csproj");
    expect(
      csharpStatusLabel(status({ ...RUNNING, target: null, projects: ["/a.csproj", "/b.csproj"] })),
    ).toBe("C#: 2 projects");
  });

  test("names the missing step", () => {
    const blocked = (block: "untrusted" | "not-restored" | "old-csharp-ls") =>
      csharpStatusLabel(status({ kind: "blocked", block, message: "m" }));
    expect(blocked("untrusted")).toBe("C#: Not trusted");
    expect(blocked("not-restored")).toBe("C#: Not restored");
    expect(blocked("old-csharp-ls")).toBe("C#: csharp-ls too old");
  });
});

describe("csharpStatusWarning", () => {
  test("warns where something needs doing", () => {
    expect(csharpStatusWarning(status(RUNNING))).toBe(false);
    expect(csharpStatusWarning(status({ kind: "stopped" }))).toBe(false);
    expect(csharpStatusWarning(status({ kind: "blocked", block: "no-dotnet", message: "m" }))).toBe(
      true,
    );
    expect(csharpStatusWarning(status(RUNNING, { chosen: "/x.sln", chosenMissing: true }))).toBe(
      true,
    );
  });
});

describe("csharpStatusTooltip", () => {
  test("gives what loaded, the SDK and where the choice came from", () => {
    const tooltip = csharpStatusTooltip(status(RUNNING, { chosen: RUNNING.target }), WT);
    expect(tooltip).toContain("Loaded: src/All.slnx");
    expect(tooltip).toContain(".NET SDK 10.0.403");
    expect(tooltip).toContain("Chosen for this worktree");
    expect(csharpStatusTooltip(status(RUNNING), WT)).toContain("Detected automatically");
  });

  test("gives the manager's words for a missing step", () => {
    const message = "Run `dotnet tool update --global csharp-ls` in a terminal.";
    expect(
      csharpStatusTooltip(status({ kind: "blocked", block: "old-csharp-ls", message }), WT),
    ).toContain(message);
  });

  test("says the chosen solution is gone", () => {
    const tooltip = csharpStatusTooltip(
      status(RUNNING, { chosen: `${WT}/Gone.sln`, chosenMissing: true }),
      WT,
    );
    expect(tooltip).toContain("Gone.sln is gone");
    expect(tooltip).toContain("Detected automatically");
  });
});
