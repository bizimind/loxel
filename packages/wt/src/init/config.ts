import { join } from "node:path";

import { wrapError } from "@bizimind/cli-common";

export interface InitConfig {
  editor?: string;
  baseBranch: string;
  worktreesDir?: string;
}

/**
 * Generate wt.yaml content from init options using string templating.
 * This allows us to include helpful comments documenting features.
 */
export function generateWtYamlContent(config: InitConfig): string {
  const worktreesDir = config.worktreesDir ?? ".worktrees";
  const autoOpen = config.editor ? "true" : "false";

  // Build editor line - commented out if not set
  const editorLine = config.editor
    ? `editor: '${config.editor}'`
    : `# editor: 'code'  # Uncomment and set your editor (code, cursor, zed, etc.)`;

  return `# yaml-language-server: $schema=https://loxel.bizimind.io/wt/schema.json

# wt.yaml - Git worktree manager configuration
# Documentation: https://github.com/bizimind/loxel/tree/main/packages/wt

# Editor command to open worktrees
${editorLine}

# Directory for worktrees (relative to this config file)
worktrees_dir: '${worktreesDir}'

# Automatically open editor after creating worktree
auto_open: ${autoOpen}

# Automatically create a new branch when creating a worktree
auto_branch: true

# Base branch for new worktree branches
base_branch: '${config.baseBranch}'

# Port offsetting - each worktree gets unique port offsets
# This prevents port conflicts when running multiple dev servers
port_offseting:
  offset: 10  # Increment between worktrees (0, 10, 20, ...)
  # ports:    # Define ports to offset - available as env vars in hooks
  #   PORT: 3000
  #   POSTGRES_PORT: 5432

# Unique naming for resources like Docker containers
unique_naming:
  strategy: 'worktree-name'  # 'worktree-name' or 'random'
  # envs:    # Define env vars with \${WT_UNIQUE_NAME} substitution
  #   CONTAINER_NAME: myapp-\${WT_UNIQUE_NAME}
  #   DATABASE_NAME: myapp_\${WT_UNIQUE_NAME}

# Lifecycle hooks
# hooks:
#   add:     # Runs when creating a new worktree (wt add)
#     files:  # Files to provision in new worktrees
#       - '**/.env.local'              # String: simple copy (preserves path)
#       - source: 'config.json'        # Copy with custom destination
#         dest: 'app/config.json'
#       - template_file: '.env.template'  # File-based template
#         dest: '.env'                    # \${VAR} placeholders replaced
#       - inline_template: |              # Inline template (no source file)
#           PORT=\${WT_PORT_OFFSET}
#           NAME=\${WT_UNIQUE_NAME}
#         dest: '.env.ports'
#     run: |
#       echo "Setting up worktree $WT_NAME..."
#       # All port_offseting.ports and unique_naming.envs are available here
#       npm install
#
#   clean:   # Runs when removing a worktree (wt remove)
#     run: |
#       echo "Cleaning up $WT_NAME..."
#       docker stop $CONTAINER_NAME 2>/dev/null || true
`;
}

/**
 * Write wt.yaml to the specified directory.
 */
export async function writeWtYaml(cwd: string, config: InitConfig): Promise<void> {
  const content = generateWtYamlContent(config);
  const configPath = join(cwd, "wt.yaml");

  try {
    await Bun.write(configPath, content);
  } catch (err) {
    throw wrapError(`Failed to write ${configPath}`, err);
  }
}
