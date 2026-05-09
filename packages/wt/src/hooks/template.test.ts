import { describe, test, expect } from "bun:test";

import { processTemplate } from "./template.ts";

describe("processTemplate", () => {
  test("replaces single variable", () => {
    expect(processTemplate("PORT=${PORT}", { PORT: "3000" })).toBe("PORT=3000");
  });

  test("replaces multiple different variables", () => {
    const content = "HOST=${HOST}:${PORT}";
    const env = { HOST: "localhost", PORT: "3000" };
    expect(processTemplate(content, env)).toBe("HOST=localhost:3000");
  });

  test("preserves unknown variables", () => {
    expect(processTemplate("${UNKNOWN}", {})).toBe("${UNKNOWN}");
  });

  test("handles WT_ prefixed variables", () => {
    const content = "NAME=${WT_NAME}\nPATH=${WT_PATH}";
    const env = { WT_NAME: "feature-x", WT_PATH: "/path/to/wt" };
    expect(processTemplate(content, env)).toBe("NAME=feature-x\nPATH=/path/to/wt");
  });

  test("handles multiple occurrences of same variable", () => {
    expect(processTemplate("${X}-${X}", { X: "foo" })).toBe("foo-foo");
  });

  test("handles empty content", () => {
    expect(processTemplate("", { X: "foo" })).toBe("");
  });

  test("ignores $VAR without braces", () => {
    expect(processTemplate("$PORT", { PORT: "3000" })).toBe("$PORT");
  });

  test("ignores empty braces", () => {
    expect(processTemplate("${}", { "": "value" })).toBe("${}");
  });

  test("ignores lowercase variables", () => {
    expect(processTemplate("${port}", { port: "3000" })).toBe("${port}");
  });

  test("handles variable at start of content", () => {
    expect(processTemplate("${VAR} rest", { VAR: "start" })).toBe("start rest");
  });

  test("handles variable at end of content", () => {
    expect(processTemplate("start ${VAR}", { VAR: "end" })).toBe("start end");
  });

  test("handles variables with underscores", () => {
    expect(processTemplate("${MY_VAR_NAME}", { MY_VAR_NAME: "value" })).toBe("value");
  });

  test("handles variables with numbers", () => {
    expect(processTemplate("${VAR1} ${VAR2}", { VAR1: "one", VAR2: "two" })).toBe("one two");
  });

  test("handles multiline content", () => {
    const content = "# Config\nPORT=${PORT}\nHOST=${HOST}\n";
    const env = { PORT: "3000", HOST: "localhost" };
    const expected = "# Config\nPORT=3000\nHOST=localhost\n";
    expect(processTemplate(content, env)).toBe(expected);
  });

  test("preserves content without variables", () => {
    const content = "No variables here\nJust plain text";
    expect(processTemplate(content, { VAR: "value" })).toBe(content);
  });

  test("handles realistic .env template", () => {
    const content = [
      "# Database",
      "DATABASE_URL=postgres://localhost:${DB_PORT}/app_${WT_UNIQUE_NAME}",
      "",
      "# Ports",
      "API_PORT=${API_PORT}",
      "FRONTEND_PORT=${FRONTEND_PORT}",
      "",
      "# Container",
      "COMPOSE_PROJECT_NAME=myapp_${WT_UNIQUE_NAME}",
      "",
    ].join("\n");
    const env = {
      DB_PORT: "5452",
      WT_UNIQUE_NAME: "feature-auth",
      API_PORT: "8090",
      FRONTEND_PORT: "3010",
    };
    const expected = [
      "# Database",
      "DATABASE_URL=postgres://localhost:5452/app_feature-auth",
      "",
      "# Ports",
      "API_PORT=8090",
      "FRONTEND_PORT=3010",
      "",
      "# Container",
      "COMPOSE_PROJECT_NAME=myapp_feature-auth",
      "",
    ].join("\n");
    expect(processTemplate(content, env)).toBe(expected);
  });

  // Escape syntax tests
  describe("escape syntax", () => {
    test("single backslash escapes variable - outputs literal", () => {
      expect(processTemplate("\\${PORT}", { PORT: "3000" })).toBe("${PORT}");
    });

    test("escaped variable is not substituted even when defined", () => {
      expect(processTemplate("\\${VAR}", { VAR: "value" })).toBe("${VAR}");
    });

    test("double backslash outputs single backslash and substitutes", () => {
      expect(processTemplate("\\\\${PORT}", { PORT: "3000" })).toBe("\\3000");
    });

    test("triple backslash outputs single backslash and literal variable", () => {
      expect(processTemplate("\\\\\\${PORT}", { PORT: "3000" })).toBe("\\${PORT}");
    });

    test("quad backslash outputs double backslash and substitutes", () => {
      expect(processTemplate("\\\\\\\\${PORT}", { PORT: "3000" })).toBe("\\\\3000");
    });

    test("mixed escaped and unescaped in same content", () => {
      const content = "literal: \\${VAR}, replaced: ${VAR}";
      expect(processTemplate(content, { VAR: "value" })).toBe("literal: ${VAR}, replaced: value");
    });

    test("escaped unknown variable stays literal", () => {
      expect(processTemplate("\\${UNKNOWN}", {})).toBe("${UNKNOWN}");
    });

    test("escape works in realistic template", () => {
      const content = [
        "# This ${VAR} will be replaced",
        "# This \\${VAR} will stay literal",
        "PORT=${PORT}",
        "SHELL_VAR=\\${SHELL_VAR}",
      ].join("\n");
      const env = { VAR: "value", PORT: "3000" };
      const expected = [
        "# This value will be replaced",
        "# This ${VAR} will stay literal",
        "PORT=3000",
        "SHELL_VAR=${SHELL_VAR}",
      ].join("\n");
      expect(processTemplate(content, env)).toBe(expected);
    });
  });
});
