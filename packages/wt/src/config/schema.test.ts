import { describe, test, expect } from "bun:test";

import type { CopyItem, TemplateFileItem, InlineTemplateItem } from "./schema.ts";
import {
  PortOffsetingSchema,
  UniqueNamingSchema,
  CopyItemSchema,
  TemplateFileItemSchema,
  InlineTemplateItemSchema,
  FileItemSchema,
  AddHookSchema,
  CleanHookSchema,
  WtConfigSchema,
} from "./schema.ts";

describe("PortOffsetingSchema", () => {
  test("applies defaults when empty", () => {
    const result = PortOffsetingSchema.parse({});
    expect(result).toEqual({ enable: true, offset: 10 });
  });

  test("accepts valid custom config", () => {
    const result = PortOffsetingSchema.parse({
      enable: false,
      offset: 100,
      ports: { PORT: 3000, API_PORT: 8080 },
    });
    expect(result).toEqual({ enable: false, offset: 100, ports: { PORT: 3000, API_PORT: 8080 } });
  });

  test("rejects negative offset", () => {
    expect(() => PortOffsetingSchema.parse({ offset: -1 })).toThrow();
  });

  test("rejects zero offset", () => {
    expect(() => PortOffsetingSchema.parse({ offset: 0 })).toThrow();
  });

  test("rejects float offset", () => {
    expect(() => PortOffsetingSchema.parse({ offset: 1.5 })).toThrow();
  });

  test("rejects negative port number", () => {
    expect(() => PortOffsetingSchema.parse({ ports: { PORT: -1 } })).toThrow();
  });
});

describe("UniqueNamingSchema", () => {
  test("applies defaults when empty", () => {
    const result = UniqueNamingSchema.parse({});
    expect(result).toEqual({ enable: true, strategy: "worktree-name" });
  });

  test("accepts 'random' strategy", () => {
    const result = UniqueNamingSchema.parse({ strategy: "random" });
    expect(result.strategy).toBe("random");
  });

  test("accepts 'worktree-name' strategy", () => {
    const result = UniqueNamingSchema.parse({ strategy: "worktree-name" });
    expect(result.strategy).toBe("worktree-name");
  });

  test("rejects invalid strategy", () => {
    expect(() => UniqueNamingSchema.parse({ strategy: "invalid" })).toThrow();
  });

  test("accepts envs map", () => {
    const result = UniqueNamingSchema.parse({ envs: { DOCKER_NAME: "service-${WT_UNIQUE_NAME}" } });
    expect(result.envs).toEqual({ DOCKER_NAME: "service-${WT_UNIQUE_NAME}" });
  });
});

describe("CopyItemSchema", () => {
  test("accepts source only", () => {
    const result = CopyItemSchema.parse({ source: "*.env" });
    expect(result.source).toBe("*.env");
    expect(result.dest).toBeUndefined();
  });

  test("accepts source with dest", () => {
    const result = CopyItemSchema.parse({ source: "config.json", dest: "app/config.json" });
    expect(result.source).toBe("config.json");
    expect(result.dest).toBe("app/config.json");
  });
});

describe("TemplateFileItemSchema", () => {
  test("accepts template_file only", () => {
    const result = TemplateFileItemSchema.parse({ template_file: ".env.template" });
    expect(result.template_file).toBe(".env.template");
    expect(result.dest).toBeUndefined();
  });

  test("accepts template_file with dest", () => {
    const result = TemplateFileItemSchema.parse({ template_file: ".env.template", dest: ".env" });
    expect(result.template_file).toBe(".env.template");
    expect(result.dest).toBe(".env");
  });
});

describe("InlineTemplateItemSchema", () => {
  test("accepts inline_template with dest", () => {
    const result = InlineTemplateItemSchema.parse({
      inline_template: "PORT=${PORT}",
      dest: ".env",
    });
    expect(result.inline_template).toBe("PORT=${PORT}");
    expect(result.dest).toBe(".env");
  });

  test("rejects inline_template without dest", () => {
    expect(() => InlineTemplateItemSchema.parse({ inline_template: "PORT=${PORT}" })).toThrow();
  });
});

describe("FileItemSchema", () => {
  test("accepts string item", () => {
    const result = FileItemSchema.parse("*.env");
    expect(result).toBe("*.env");
  });

  test("accepts copy item (source only)", () => {
    const result = FileItemSchema.parse({ source: "file.txt" });
    expect(result).toEqual({ source: "file.txt" });
  });

  test("accepts copy item with dest", () => {
    const result = FileItemSchema.parse({ source: "file.txt", dest: "renamed.txt" });
    expect(result).toEqual({ source: "file.txt", dest: "renamed.txt" });
  });

  test("accepts template_file item", () => {
    const result = FileItemSchema.parse({ template_file: ".env.template", dest: ".env" });
    expect((result as TemplateFileItem).template_file).toBe(".env.template");
    expect((result as TemplateFileItem).dest).toBe(".env");
  });

  test("accepts inline_template item", () => {
    const result = FileItemSchema.parse({ inline_template: "PORT=${PORT}", dest: ".env" });
    expect((result as InlineTemplateItem).inline_template).toBe("PORT=${PORT}");
    expect((result as InlineTemplateItem).dest).toBe(".env");
  });
});

describe("AddHookSchema", () => {
  test("accepts string-only files array", () => {
    const result = AddHookSchema.parse({ files: ["*.env", "docker-compose.yml"] });
    expect(result.files).toEqual(["*.env", "docker-compose.yml"]);
  });

  test("accepts copy items in files array", () => {
    const result = AddHookSchema.parse({ files: [{ source: ".env.local", dest: "config/.env" }] });
    expect(result.files).toEqual([{ source: ".env.local", dest: "config/.env" }]);
  });

  test("accepts template_file items in files array", () => {
    const result = AddHookSchema.parse({
      files: [{ template_file: ".env.template", dest: ".env" }],
    });
    expect(result.files).toEqual([{ template_file: ".env.template", dest: ".env" }]);
  });

  test("accepts inline_template items in files array", () => {
    const result = AddHookSchema.parse({
      files: [{ inline_template: "PORT=${WT_PORT_OFFSET}", dest: ".env" }],
    });
    expect(result.files).toEqual([{ inline_template: "PORT=${WT_PORT_OFFSET}", dest: ".env" }]);
  });

  test("accepts mixed file item types", () => {
    const result = AddHookSchema.parse({
      files: [
        ".env.local",
        { source: "config.json", dest: "app/config.json" },
        { template_file: ".env.template", dest: ".env" },
        { inline_template: "NAME=${WT_NAME}", dest: "name.txt" },
      ],
    });
    expect(result.files).toHaveLength(4);
    expect(result.files![0]).toBe(".env.local");
    expect((result.files![1] as CopyItem).source).toBe("config.json");
    expect((result.files![2] as TemplateFileItem).template_file).toBe(".env.template");
    expect((result.files![3] as InlineTemplateItem).inline_template).toBe("NAME=${WT_NAME}");
  });

  test("accepts run script", () => {
    const result = AddHookSchema.parse({ run: "npm install" });
    expect(result.run).toBe("npm install");
  });

  test("accepts both files and run", () => {
    const result = AddHookSchema.parse({ files: ["*.env"], run: "npm install" });
    expect(result.files).toEqual(["*.env"]);
    expect(result.run).toBe("npm install");
  });

  test("accepts empty object", () => {
    const result = AddHookSchema.parse({});
    expect(result.files).toBeUndefined();
    expect(result.run).toBeUndefined();
  });
});

describe("CleanHookSchema", () => {
  test("accepts run script", () => {
    const result = CleanHookSchema.parse({ run: "docker-compose down" });
    expect(result.run).toBe("docker-compose down");
  });

  test("accepts empty object", () => {
    const result = CleanHookSchema.parse({});
    expect(result.run).toBeUndefined();
  });
});

describe("WtConfigSchema", () => {
  test("accepts minimal valid config", () => {
    const result = WtConfigSchema.parse({});
    expect(result.worktrees_dir).toBe(".worktrees");
    expect(result.auto_open).toBe(true);
    expect(result.auto_branch).toBe(true);
    expect(result.base_branch).toBe("main");
    expect(result.remote).toBe("origin");
    expect(result.copy_source).toBe(".wt-local-res");
  });

  test("accepts full valid config with all file item types", () => {
    const result = WtConfigSchema.parse({
      editor: "code",
      worktrees_dir: ".wts",
      auto_open: false,
      auto_branch: false,
      base_branch: "develop",
      remote: "upstream",
      port_offseting: { enable: true, offset: 100, ports: { PORT: 3000 } },
      unique_naming: { enable: true, strategy: "random", envs: { NAME: "${WT_UNIQUE_NAME}" } },
      copy_source: "~/shared",
      hooks: {
        add: {
          files: [
            "*.env",
            { source: "config.json" },
            { template_file: ".env.template", dest: ".env" },
            { inline_template: "PORT=${WT_PORT_OFFSET}", dest: "ports.env" },
          ],
          run: "npm i",
        },
        clean: { run: "cleanup.sh" },
      },
    });

    expect(result.editor).toBe("code");
    expect(result.worktrees_dir).toBe(".wts");
    expect(result.auto_open).toBe(false);
    expect(result.port_offseting.offset).toBe(100);
    expect(result.unique_naming.strategy).toBe("random");
    expect(result.copy_source).toBe("~/shared");
    expect(result.hooks!.add!.files).toHaveLength(4);
    expect(result.hooks!.add!.files![0]).toBe("*.env");
    expect((result.hooks!.add!.files![1] as CopyItem).source).toBe("config.json");
    expect((result.hooks!.add!.files![2] as TemplateFileItem).template_file).toBe(".env.template");
    expect((result.hooks!.add!.files![3] as InlineTemplateItem).inline_template).toBe(
      "PORT=${WT_PORT_OFFSET}",
    );
    expect(result.hooks?.clean?.run).toBe("cleanup.sh");
  });

  test("applies port_offseting defaults", () => {
    const result = WtConfigSchema.parse({});
    expect(result.port_offseting.enable).toBe(true);
    expect(result.port_offseting.offset).toBe(10);
  });

  test("applies unique_naming defaults", () => {
    const result = WtConfigSchema.parse({});
    expect(result.unique_naming.enable).toBe(true);
    expect(result.unique_naming.strategy).toBe("worktree-name");
  });
});
