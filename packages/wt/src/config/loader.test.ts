import { describe, test, expect } from "bun:test";

import { parseWtConfig, getWorktreesDir, type LoadedConfig } from "./loader.ts";

describe("parseWtConfig", () => {
  test("parses valid minimal YAML", () => {
    const yaml = `editor: code`;
    const config = parseWtConfig(yaml, "/path/to/wt.yaml");

    expect(config.editor).toBe("code");
    expect(config.worktrees_dir).toBe(".worktrees");
    expect(config.auto_open).toBe(true);
  });

  test("parses valid full YAML", () => {
    const yaml = `
editor: cursor
worktrees_dir: .wt
auto_open: false
auto_branch: false
base_branch: develop
remote: upstream
port_offseting:
  enable: true
  offset: 100
  ports:
    PORT: 3000
    API_PORT: 8080
unique_naming:
  enable: true
  strategy: random
  envs:
    DOCKER_NAME: "svc-\${WT_UNIQUE_NAME}"
copy_source: ~/shared
hooks:
  add:
    files:
      - "*.env"
      - docker-compose.yml
      - template_file: ".env.template"
        dest: ".env"
      - inline_template: "PORT=\${WT_PORT_OFFSET}"
        dest: "ports.env"
    run: npm install
  clean:
    run: docker-compose down
`;
    const config = parseWtConfig(yaml, "/path/to/wt.yaml");

    expect(config.editor).toBe("cursor");
    expect(config.worktrees_dir).toBe(".wt");
    expect(config.auto_open).toBe(false);
    expect(config.auto_branch).toBe(false);
    expect(config.base_branch).toBe("develop");
    expect(config.remote).toBe("upstream");
    expect(config.port_offseting.offset).toBe(100);
    expect(config.port_offseting.ports).toEqual({ PORT: 3000, API_PORT: 8080 });
    expect(config.unique_naming.strategy).toBe("random");
    expect(config.copy_source).toBe("~/shared");
    expect(config.hooks?.add?.files).toHaveLength(4);
    expect(config.hooks?.add?.files?.[0]).toBe("*.env");
    expect(config.hooks?.add?.files?.[1]).toBe("docker-compose.yml");
    expect(config.hooks?.add?.files?.[2]).toEqual({ template_file: ".env.template", dest: ".env" });
    expect(config.hooks?.add?.files?.[3]).toEqual({
      inline_template: "PORT=${WT_PORT_OFFSET}",
      dest: "ports.env",
    });
    expect(config.hooks?.add?.run).toBe("npm install");
    expect(config.hooks?.clean?.run).toBe("docker-compose down");
  });

  test("throws Error on invalid YAML syntax", () => {
    const yaml = `
editor: code
  invalid: indentation
`;
    expect(() => parseWtConfig(yaml, "/path/to/wt.yaml")).toThrow(Error);
    expect(() => parseWtConfig(yaml, "/path/to/wt.yaml")).toThrow(
      "Failed to parse /path/to/wt.yaml",
    );
  });

  test("throws Error with details on schema validation error", () => {
    const yaml = `
port_offseting:
  offset: -5
`;
    expect(() => parseWtConfig(yaml, "/path/to/wt.yaml")).toThrow(Error);
    expect(() => parseWtConfig(yaml, "/path/to/wt.yaml")).toThrow(
      "Invalid config in /path/to/wt.yaml",
    );
  });

  test("throws Error on invalid strategy", () => {
    const yaml = `
unique_naming:
  strategy: invalid_strategy
`;
    expect(() => parseWtConfig(yaml, "/path/to/wt.yaml")).toThrow(Error);
  });

  test("includes config path in error message", () => {
    const yaml = `port_offseting: { offset: 0 }`;
    try {
      parseWtConfig(yaml, "/my/custom/path/wt.yaml");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("/my/custom/path/wt.yaml");
    }
  });
});

describe("getWorktreesDir", () => {
  test("combines rootDir with default worktrees_dir", () => {
    const loaded: LoadedConfig = {
      config: {
        worktrees_dir: ".worktrees",
        auto_open: true,
        auto_branch: true,
        base_branch: "main",
        remote: "origin",
        port_offseting: { enable: true, offset: 10 },
        unique_naming: { enable: true, strategy: "worktree-name" },
        copy_source: ".wt-local-res",
        automatic_updates: false,
      },
      configPath: "/repo/wt.yaml",
      rootDir: "/repo",
    };

    expect(getWorktreesDir(loaded)).toBe("/repo/.worktrees");
  });

  test("combines rootDir with custom worktrees_dir", () => {
    const loaded: LoadedConfig = {
      config: {
        worktrees_dir: "my-worktrees",
        auto_open: true,
        auto_branch: true,
        base_branch: "main",
        remote: "origin",
        port_offseting: { enable: true, offset: 10 },
        unique_naming: { enable: true, strategy: "worktree-name" },
        copy_source: ".wt-local-res",
        automatic_updates: false,
      },
      configPath: "/some/path/wt.yaml",
      rootDir: "/some/path",
    };

    expect(getWorktreesDir(loaded)).toBe("/some/path/my-worktrees");
  });

  test("handles nested worktrees_dir", () => {
    const loaded: LoadedConfig = {
      config: {
        worktrees_dir: "dev/worktrees",
        auto_open: true,
        auto_branch: true,
        base_branch: "main",
        remote: "origin",
        port_offseting: { enable: true, offset: 10 },
        unique_naming: { enable: true, strategy: "worktree-name" },
        copy_source: ".wt-local-res",
        automatic_updates: false,
      },
      configPath: "/repo/wt.yaml",
      rootDir: "/repo",
    };

    expect(getWorktreesDir(loaded)).toBe("/repo/dev/worktrees");
  });
});
