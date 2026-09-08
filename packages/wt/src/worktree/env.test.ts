import { describe, test, expect } from "bun:test";

import type { PortOffsetingConfig, UniqueNamingConfig, WtConfig } from "../config/schema.ts";
import {
  computePortOffset,
  computeOffsetPorts,
  computeAllPortsOffsets,
  computeAllPortsOffsetsJson,
  computeUniqueName,
  computeUniqueEnvs,
  computeAllEnvVars,
} from "./env.ts";

describe("computePortOffset", () => {
  test("index 0 returns 0", () => {
    const config: PortOffsetingConfig = { enable: true, offset: 10 };
    expect(computePortOffset(0, config)).toBe(0);
  });

  test("index 1 with offset 10 returns 10", () => {
    const config: PortOffsetingConfig = { enable: true, offset: 10 };
    expect(computePortOffset(1, config)).toBe(10);
  });

  test("index 3 with offset 5 returns 15", () => {
    const config: PortOffsetingConfig = { enable: true, offset: 5 };
    expect(computePortOffset(3, config)).toBe(15);
  });

  test("index 5 with offset 100 returns 500", () => {
    const config: PortOffsetingConfig = { enable: true, offset: 100 };
    expect(computePortOffset(5, config)).toBe(500);
  });
});

describe("computeOffsetPorts", () => {
  test("empty ports returns empty object", () => {
    const config: PortOffsetingConfig = { enable: true, offset: 10 };
    expect(computeOffsetPorts(10, config)).toEqual({});
  });

  test("single port is offset correctly", () => {
    const config: PortOffsetingConfig = { enable: true, offset: 10, ports: { PORT: 3000 } };
    expect(computeOffsetPorts(10, config)).toEqual({ PORT: 3010 });
  });

  test("multiple ports are offset correctly", () => {
    const config: PortOffsetingConfig = {
      enable: true,
      offset: 10,
      ports: { PORT: 3000, API_PORT: 8080, DB_PORT: 5432 },
    };
    expect(computeOffsetPorts(20, config)).toEqual({ PORT: 3020, API_PORT: 8100, DB_PORT: 5452 });
  });

  test("zero offset returns base ports", () => {
    const config: PortOffsetingConfig = { enable: true, offset: 10, ports: { PORT: 3000 } };
    expect(computeOffsetPorts(0, config)).toEqual({ PORT: 3000 });
  });
});

describe("computeAllPortsOffsets", () => {
  test("empty returns empty string", () => {
    expect(computeAllPortsOffsets({})).toBe("");
  });

  test("single port returns KEY=value", () => {
    expect(computeAllPortsOffsets({ PORT: 3010 })).toBe("PORT=3010");
  });

  test("multiple ports returns multiline", () => {
    const result = computeAllPortsOffsets({ PORT: 3010, API: 8090 });
    expect(result).toContain("PORT=3010");
    expect(result).toContain("API=8090");
    expect(result.split("\n")).toHaveLength(2);
  });
});

describe("computeAllPortsOffsetsJson", () => {
  test("empty returns empty JSON object", () => {
    expect(computeAllPortsOffsetsJson({})).toBe("{}");
  });

  test("single port returns valid JSON", () => {
    const result = computeAllPortsOffsetsJson({ PORT: 3010 });
    expect(result).toBe('{"PORT":3010}');
    expect(JSON.parse(result)).toEqual({ PORT: 3010 });
  });

  test("multiple ports returns valid JSON", () => {
    const result = computeAllPortsOffsetsJson({ PORT: 3010, API: 8090 });
    const parsed = JSON.parse(result);
    expect(parsed.PORT).toBe(3010);
    expect(parsed.API).toBe(8090);
  });
});

describe("computeUniqueName", () => {
  describe("worktree-name strategy", () => {
    test("simple name unchanged", () => {
      expect(computeUniqueName("feature-auth", "worktree-name")).toBe("feature-auth");
    });

    test("uppercase converted to lowercase", () => {
      expect(computeUniqueName("Feature_Auth", "worktree-name")).toBe("feature-auth");
    });

    test("slashes replaced with hyphens", () => {
      expect(computeUniqueName("feature/auth", "worktree-name")).toBe("feature-auth");
    });

    test("all uppercase converted", () => {
      expect(computeUniqueName("BUGFIX-123", "worktree-name")).toBe("bugfix-123");
    });

    test("leading special chars removed", () => {
      expect(computeUniqueName("---leading", "worktree-name")).toBe("leading");
    });

    test("trailing special chars removed", () => {
      expect(computeUniqueName("trailing---", "worktree-name")).toBe("trailing");
    });

    test("consecutive hyphens collapsed", () => {
      expect(computeUniqueName("multiple--consecutive", "worktree-name")).toBe(
        "multiple-consecutive",
      );
    });

    test("complex name normalized", () => {
      expect(computeUniqueName("Feature/BUGFIX_123--test", "worktree-name")).toBe(
        "feature-bugfix-123-test",
      );
    });
  });

  describe("random strategy", () => {
    test("returns 8 character string", () => {
      const result = computeUniqueName("anything", "random");
      expect(result).toHaveLength(8);
    });

    test("starts with a letter", () => {
      for (let i = 0; i < 10; i++) {
        const result = computeUniqueName("test", "random");
        expect(result[0]).toMatch(/[a-zA-Z]/);
      }
    });

    test("contains only alphanumeric characters", () => {
      for (let i = 0; i < 10; i++) {
        const result = computeUniqueName("test", "random");
        expect(result).toMatch(/^[a-zA-Z][a-zA-Z0-9]{7}$/);
      }
    });

    test("generates different values", () => {
      const results = new Set<string>();
      for (let i = 0; i < 10; i++) {
        results.add(computeUniqueName("test", "random"));
      }
      // Should have multiple unique values (very unlikely to have all same)
      expect(results.size).toBeGreaterThan(1);
    });
  });
});

describe("computeUniqueEnvs", () => {
  test("empty envs returns empty object", () => {
    const config: UniqueNamingConfig = { enable: true, strategy: "worktree-name" };
    expect(computeUniqueEnvs("myname", config)).toEqual({});
  });

  test("single env with substitution", () => {
    const config: UniqueNamingConfig = {
      enable: true,
      strategy: "worktree-name",
      envs: { DOCKER_NAME: "service-${WT_UNIQUE_NAME}" },
    };
    expect(computeUniqueEnvs("myname", config)).toEqual({ DOCKER_NAME: "service-myname" });
  });

  test("multiple envs with substitution", () => {
    const config: UniqueNamingConfig = {
      enable: true,
      strategy: "worktree-name",
      envs: { DOCKER_NAME: "svc-${WT_UNIQUE_NAME}", DB_NAME: "db_${WT_UNIQUE_NAME}" },
    };
    expect(computeUniqueEnvs("test", config)).toEqual({
      DOCKER_NAME: "svc-test",
      DB_NAME: "db_test",
    });
  });

  test("env without placeholder unchanged", () => {
    const config: UniqueNamingConfig = {
      enable: true,
      strategy: "worktree-name",
      envs: { STATIC: "no-placeholder-here" },
    };
    expect(computeUniqueEnvs("myname", config)).toEqual({ STATIC: "no-placeholder-here" });
  });

  test("multiple placeholders in same env", () => {
    const config: UniqueNamingConfig = {
      enable: true,
      strategy: "worktree-name",
      envs: { COMPLEX: "${WT_UNIQUE_NAME}-${WT_UNIQUE_NAME}" },
    };
    expect(computeUniqueEnvs("x", config)).toEqual({ COMPLEX: "x-x" });
  });

  test("WT_PORT_OFFSET substitution when portOffset provided", () => {
    const config: UniqueNamingConfig = {
      enable: true,
      strategy: "worktree-name",
      envs: { COMPOSE_PROJECT_NAME: "${WT_UNIQUE_NAME}_${WT_PORT_OFFSET}" },
    };
    expect(computeUniqueEnvs("myapp", config, 20)).toEqual({ COMPOSE_PROJECT_NAME: "myapp_20" });
  });

  test("WT_PORT_OFFSET unchanged when portOffset not provided", () => {
    const config: UniqueNamingConfig = {
      enable: true,
      strategy: "worktree-name",
      envs: { NAME: "${WT_UNIQUE_NAME}_${WT_PORT_OFFSET}" },
    };
    expect(computeUniqueEnvs("app", config)).toEqual({ NAME: "app_${WT_PORT_OFFSET}" });
  });

  test("mixed WT_UNIQUE_NAME and WT_PORT_OFFSET in multiple envs", () => {
    const config: UniqueNamingConfig = {
      enable: true,
      strategy: "worktree-name",
      envs: {
        DOCKER: "svc-${WT_UNIQUE_NAME}",
        COMPOSE: "${WT_UNIQUE_NAME}_${WT_PORT_OFFSET}",
        PORTS_ONLY: "offset-${WT_PORT_OFFSET}",
      },
    };
    expect(computeUniqueEnvs("test", config, 50)).toEqual({
      DOCKER: "svc-test",
      COMPOSE: "test_50",
      PORTS_ONLY: "offset-50",
    });
  });

  test("WT_PORT_OFFSET zero value substitutes correctly", () => {
    const config: UniqueNamingConfig = {
      enable: true,
      strategy: "worktree-name",
      envs: { NAME: "${WT_UNIQUE_NAME}_${WT_PORT_OFFSET}" },
    };
    expect(computeUniqueEnvs("app", config, 0)).toEqual({ NAME: "app_0" });
  });
});

describe("computeAllEnvVars", () => {
  const baseConfig: WtConfig = {
    worktrees_dir: ".worktrees",
    auto_open: true,
    auto_branch: true,
    base_branch: "main",
    remote: "origin",
    port_offseting: { enable: false, offset: 10 },
    unique_naming: { enable: false, strategy: "worktree-name" },
    copy_source: ".wt-local-res",
    automatic_updates: false,
  };

  test("always includes WT_NAME, WT_PATH, and WT_ROOT", () => {
    const result = computeAllEnvVars("my-wt", "/path/to/wt", "/repo", 0, baseConfig);
    expect(result.WT_NAME).toBe("my-wt");
    expect(result.WT_PATH).toBe("/path/to/wt");
    expect(result.WT_ROOT).toBe("/repo");
  });

  test("disabled port_offseting excludes port vars", () => {
    const result = computeAllEnvVars("wt", "/path", "/repo", 1, baseConfig);
    expect(result.WT_PORT_OFFSET).toBeUndefined();
    expect(result.WT_ALL_PORTS_OFFSETS).toBeUndefined();
  });

  test("enabled port_offseting includes port vars", () => {
    const config: WtConfig = {
      ...baseConfig,
      port_offseting: { enable: true, offset: 10, ports: { PORT: 3000 } },
    };
    const result = computeAllEnvVars("wt", "/path", "/repo", 2, config);

    expect(result.WT_PORT_OFFSET).toBe("20");
    expect(result.PORT).toBe("3020");
    expect(result.WT_ALL_PORTS_OFFSETS).toBe("PORT=3020");
    expect(result.WT_ALL_PORTS_OFFSETS_JSON).toBe('{"PORT":3020}');
  });

  test("disabled unique_naming excludes unique vars", () => {
    const result = computeAllEnvVars("wt", "/path", "/repo", 0, baseConfig);
    expect(result.WT_UNIQUE_NAME).toBeUndefined();
  });

  test("enabled unique_naming includes unique vars", () => {
    const config: WtConfig = {
      ...baseConfig,
      unique_naming: {
        enable: true,
        strategy: "worktree-name",
        envs: { DOCKER: "svc-${WT_UNIQUE_NAME}" },
      },
    };
    const result = computeAllEnvVars("Feature-X", "/path", "/repo", 0, config);

    expect(result.WT_UNIQUE_NAME).toBe("feature-x");
    expect(result.DOCKER).toBe("svc-feature-x");
  });

  test("full config includes all vars", () => {
    const config: WtConfig = {
      ...baseConfig,
      port_offseting: { enable: true, offset: 100, ports: { API: 8080 } },
      unique_naming: {
        enable: true,
        strategy: "worktree-name",
        envs: { NAME: "${WT_UNIQUE_NAME}-app" },
      },
    };
    const result = computeAllEnvVars("Test_Branch", "/worktrees/test", "/repo", 1, config);

    expect(result.WT_NAME).toBe("Test_Branch");
    expect(result.WT_PATH).toBe("/worktrees/test");
    expect(result.WT_ROOT).toBe("/repo");
    expect(result.WT_PORT_OFFSET).toBe("100");
    expect(result.API).toBe("8180");
    expect(result.WT_UNIQUE_NAME).toBe("test-branch");
    expect(result.NAME).toBe("test-branch-app");
  });

  test("unique_naming envs can use WT_PORT_OFFSET when port_offseting enabled", () => {
    const config: WtConfig = {
      ...baseConfig,
      port_offseting: { enable: true, offset: 10, ports: { PORT: 3000 } },
      unique_naming: {
        enable: true,
        strategy: "worktree-name",
        envs: { COMPOSE_PROJECT_NAME: "${WT_UNIQUE_NAME}_${WT_PORT_OFFSET}" },
      },
    };
    const result = computeAllEnvVars("feature-auth", "/worktrees/feature-auth", "/repo", 2, config);

    expect(result.WT_PORT_OFFSET).toBe("20");
    expect(result.WT_UNIQUE_NAME).toBe("feature-auth");
    expect(result.COMPOSE_PROJECT_NAME).toBe("feature-auth_20");
  });

  test("unique_naming envs with WT_PORT_OFFSET when port_offseting disabled", () => {
    const config: WtConfig = {
      ...baseConfig,
      port_offseting: { enable: false, offset: 10 },
      unique_naming: {
        enable: true,
        strategy: "worktree-name",
        envs: { NAME: "${WT_UNIQUE_NAME}_${WT_PORT_OFFSET}" },
      },
    };
    const result = computeAllEnvVars("test", "/worktrees/test", "/repo", 0, config);

    expect(result.WT_PORT_OFFSET).toBeUndefined();
    expect(result.WT_UNIQUE_NAME).toBe("test");
    // When port_offseting is disabled, ${WT_PORT_OFFSET} is not substituted
    expect(result.NAME).toBe("test_${WT_PORT_OFFSET}");
  });
});
