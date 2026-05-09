import { z } from "zod";

/**
 * Port offsetting configuration.
 * Each worktree gets a unique WT_PORT_OFFSET value (0, 10, 20, etc.)
 * Individual ports are offset by this value and exposed as env vars.
 */
export const PortOffsetingSchema = z
  .object({
    enable: z.boolean().default(true).describe("Enable port offsetting for worktrees."),
    /** Offset increment between worktrees (e.g., 10 means offsets of 0, 10, 20...) */
    offset: z
      .number()
      .int()
      .positive()
      .default(10)
      .describe("Offset increment between worktrees (e.g. 10 means offsets 0, 10, 20...)."),
    /** Map of env var name to base port number */
    ports: z
      .record(z.string(), z.number().int().positive())
      .optional()
      .describe("Map of env var name to base port number. Each port is offset per worktree."),
  })
  .default({ enable: true, offset: 10 })
  .describe("Port offsetting — each worktree gets a unique WT_PORT_OFFSET value.");

/**
 * Unique naming configuration for resources like containers.
 * Generates WT_UNIQUE_NAME and templated env vars.
 */
export const UniqueNamingSchema = z
  .object({
    enable: z.boolean().default(true).describe("Enable unique naming for worktree resources."),
    /**
     * Strategy for generating unique names:
     * - 'worktree-name': normalize worktree name (replace special chars with -)
     * - 'random': random 8-char base62 string starting with a letter
     */
    strategy: z
      .enum(["random", "worktree-name"])
      .default("worktree-name")
      .describe(
        "Strategy for unique names: 'worktree-name' normalizes the worktree name, 'random' generates an 8-char base62 string.",
      ),
    /** Map of env var name to template string containing ${WT_UNIQUE_NAME} */
    envs: z
      .record(z.string(), z.string())
      .optional()
      .describe("Map of env var name to template string containing ${WT_UNIQUE_NAME}."),
  })
  .default({ enable: true, strategy: "worktree-name" })
  .describe("Unique naming — generates WT_UNIQUE_NAME and templated env vars for resources.");

/**
 * Copy item - copies files as-is with optional custom destination.
 */
export const CopyItemSchema = z.object({
  /** Source glob pattern (relative to copy_source directory) */
  source: z.string().describe("Source glob pattern (relative to copy_source directory)."),
  /** Destination path (relative to worktree root). If ends with /, preserves source structure inside. */
  dest: z
    .string()
    .optional()
    .describe(
      "Destination path (relative to worktree root). If ends with /, preserves source structure inside.",
    ),
});

/**
 * Template file item - processes a template file with ${VAR} substitution.
 */
export const TemplateFileItemSchema = z.object({
  /** Template file path (relative to copy_source directory) */
  template_file: z.string().describe("Template file path (relative to copy_source directory)."),
  /** Destination path (relative to worktree root). Defaults to template_file name. */
  dest: z
    .string()
    .optional()
    .describe("Destination path (relative to worktree root). Defaults to template_file name."),
});

/**
 * Inline template item - template content defined directly in config.
 */
export const InlineTemplateItemSchema = z.object({
  /** Template content with ${VAR} placeholders */
  inline_template: z.string().describe("Template content with ${VAR} placeholders."),
  /** Destination path (required since there's no source file) */
  dest: z.string().describe("Destination path (required since there's no source file)."),
});

/**
 * File item for copying/templating during worktree creation.
 * - string: simple glob copy as-is
 * - { source, dest? }: copy with optional custom destination
 * - { template_file, dest? }: file-based template with ${VAR} substitution
 * - { inline_template, dest }: inline template content
 */
export const FileItemSchema = z.union([
  z.string(),
  CopyItemSchema,
  TemplateFileItemSchema,
  InlineTemplateItemSchema,
]);

export type FileItem = z.infer<typeof FileItemSchema>;
export type CopyItem = z.infer<typeof CopyItemSchema>;
export type TemplateFileItem = z.infer<typeof TemplateFileItemSchema>;
export type InlineTemplateItem = z.infer<typeof InlineTemplateItemSchema>;

/**
 * Add hook configuration - runs when creating a new worktree.
 */
export const AddHookSchema = z.object({
  /** File patterns to copy/template. String = copy as-is, object = advanced options. */
  files: z
    .array(FileItemSchema)
    .optional()
    .describe("File patterns to copy/template. String = copy as-is, object = advanced options."),
  /** Shell script to run after file processing */
  run: z.string().optional().describe("Shell script to run after file processing."),
});

/**
 * Clean hook configuration - runs when removing a worktree.
 */
export const CleanHookSchema = z.object({
  /** Shell script to run before removal */
  run: z.string().optional().describe("Shell script to run before worktree removal."),
});

/**
 * Copy source directory for add hooks.
 * Path to directory containing files to copy (relative to repo root, absolute, or ~/...).
 */
export const CopySourceSchema = z
  .string()
  .default(".wt-local-res")
  .describe("Directory containing files to copy during worktree creation (relative to repo root).");

/**
 * Hooks configuration.
 */
export const HooksSchema = z
  .object({
    add: AddHookSchema.optional().describe("Hook that runs when creating a new worktree."),
    clean: CleanHookSchema.optional().describe("Hook that runs when removing a worktree."),
  })
  .describe("Lifecycle hooks for worktree creation and removal.");

/**
 * Main wt.yaml configuration schema.
 */
export const WtConfigSchema = z.object({
  /** Editor command to open worktrees (e.g., 'code', 'cursor', 'zed') */
  editor: z
    .string()
    .optional()
    .describe("Editor command to open worktrees (e.g. 'code', 'cursor', 'zed')."),
  /** Directory for worktrees relative to config location */
  worktrees_dir: z
    .string()
    .default(".worktrees")
    .describe("Directory for worktrees relative to config location."),
  /** Whether to auto-open editor after creating worktree */
  auto_open: z
    .boolean()
    .default(true)
    .describe("Automatically open the editor after creating a worktree."),
  /** Whether to auto-create new branch when creating worktree */
  auto_branch: z
    .boolean()
    .default(true)
    .describe("Automatically create a new branch when creating a worktree."),
  /** Base branch for new worktree branches */
  base_branch: z.string().default("main").describe("Base branch for new worktree branches."),
  /** Remote name for fetching base branch (e.g., 'origin') */
  remote: z
    .string()
    .default("origin")
    .describe("Remote name for fetching the base branch (e.g. 'origin')."),
  /** Port offsetting configuration */
  port_offseting: PortOffsetingSchema,
  /** Unique naming configuration */
  unique_naming: UniqueNamingSchema,
  /** Copy source for add hooks (default: 'main-worktree') */
  copy_source: CopySourceSchema,
  /** Hooks configuration */
  hooks: HooksSchema.optional(),
  /** Enable automatic updates - checks for and installs updates on each command */
  automatic_updates: z
    .boolean()
    .default(false)
    .describe("Check for and install wt CLI updates on each command."),
});

export type WtConfig = z.infer<typeof WtConfigSchema>;
export type PortOffsetingConfig = z.infer<typeof PortOffsetingSchema>;
export type UniqueNamingConfig = z.infer<typeof UniqueNamingSchema>;
export type CopySourceConfig = z.infer<typeof CopySourceSchema>;
export type AddHookConfig = z.infer<typeof AddHookSchema>;
