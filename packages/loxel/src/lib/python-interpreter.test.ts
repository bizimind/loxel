import { describe, expect, test } from "bun:test";

import type { PythonInterpreter } from "@/api/python-env-model";

import { displayPythonPath, pythonEnvName, pythonInterpreterLabel } from "./python-interpreter";

const WT = "/repo/wt";

function interpreter(overrides: Partial<PythonInterpreter>): PythonInterpreter {
  return {
    source: "venv",
    pythonPath: `${WT}/.venv/bin/python`,
    envPath: `${WT}/.venv`,
    version: "3.12.13",
    ...overrides,
  };
}

describe("pythonEnvName", () => {
  test("names an environment by its path in the worktree, its directory, or global", () => {
    expect(pythonEnvName(interpreter({}), WT)).toBe(".venv");
    expect(pythonEnvName(interpreter({ envPath: `${WT}/services/api/venv` }), `${WT}/`)).toBe(
      "services/api/venv",
    );
    expect(pythonEnvName(interpreter({ envPath: "/cache/poetry/app-x1-py3.12" }), WT)).toBe(
      "app-x1-py3.12",
    );
    // A sibling directory sharing the worktree's prefix is not inside it.
    expect(pythonEnvName(interpreter({ envPath: "/repo/wt-other/.venv" }), WT)).toBe(".venv");
    expect(pythonEnvName(interpreter({ source: "system", envPath: null }), WT)).toBe("global");
  });
});

describe("pythonInterpreterLabel", () => {
  test("shows the version and the environment name", () => {
    expect(pythonInterpreterLabel(interpreter({}), WT)).toBe("Python 3.12.13 (.venv)");
    expect(pythonInterpreterLabel(interpreter({ version: null }), WT)).toBe("Python (.venv)");
  });
});

describe("displayPythonPath", () => {
  test("shortens paths inside the worktree and under home", () => {
    expect(displayPythonPath(`${WT}/.venv/bin/python`, WT, "/home/me")).toBe("./.venv/bin/python");
    expect(displayPythonPath("/home/me/.pyenv/shims/python3", WT, "/home/me")).toBe(
      "~/.pyenv/shims/python3",
    );
    expect(displayPythonPath("/usr/bin/python3", WT, null)).toBe("/usr/bin/python3");
  });
});
