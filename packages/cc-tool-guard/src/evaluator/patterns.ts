import type { ProjectContext, EvaluationResult } from "../types.ts";

import { parseCommand } from "./command-parser.ts";

interface PatternRule {
  pattern: RegExp;
  classification: "safe" | "uncertain";
  reason: string;
  suggestedPattern?: string;
}

/**
 * Dangerous patterns - these always require user confirmation
 */
const DANGEROUS_PATTERNS: PatternRule[] = [
  // Privilege escalation
  { pattern: /\bsudo\b/, classification: "uncertain", reason: "Uses sudo" },
  { pattern: /\bsu\s/, classification: "uncertain", reason: "Uses su" },
  { pattern: /\bdoas\b/, classification: "uncertain", reason: "Uses doas" },

  // Global package installs
  { pattern: /\bnpm\s+.*-g\b/, classification: "uncertain", reason: "Global npm install" },
  { pattern: /\bnpm\s+.*--global\b/, classification: "uncertain", reason: "Global npm install" },
  { pattern: /\bbrew\s+install\b/, classification: "uncertain", reason: "Homebrew install" },
  { pattern: /\bapt(-get)?\s+install\b/, classification: "uncertain", reason: "apt install" },
  { pattern: /\byum\s+install\b/, classification: "uncertain", reason: "yum install" },
  { pattern: /\bpacman\s+-S\b/, classification: "uncertain", reason: "pacman install" },
  {
    pattern: /\bpip\s+install\s+(?!-e\s|--editable).*(?<!requirements\.txt)$/,
    classification: "uncertain",
    reason: "Global pip install",
  },

  // Pipe to shell (dangerous remote code execution)
  {
    pattern: /\bcurl\b.*\|\s*(bash|sh|zsh)\b/,
    classification: "uncertain",
    reason: "Pipes curl to shell",
  },
  {
    pattern: /\bwget\b.*\|\s*(bash|sh|zsh)\b/,
    classification: "uncertain",
    reason: "Pipes wget to shell",
  },

  // Publishing packages
  { pattern: /\bnpm\s+publish\b/, classification: "uncertain", reason: "Publishing npm package" },
  {
    pattern: /\bcargo\s+publish\b/,
    classification: "uncertain",
    reason: "Publishing cargo package",
  },
  { pattern: /\bpip\s+.*upload\b/, classification: "uncertain", reason: "Publishing pip package" },
  { pattern: /\btwine\s+upload\b/, classification: "uncertain", reason: "Publishing pip package" },

  // Docker privileged/sensitive
  { pattern: /--privileged/, classification: "uncertain", reason: "Docker privileged mode" },
  { pattern: /-v\s+\/:/, classification: "uncertain", reason: "Docker mount of root filesystem" },
  { pattern: /-v\s+\/etc/, classification: "uncertain", reason: "Docker mount of /etc" },
  { pattern: /-v\s+\/var/, classification: "uncertain", reason: "Docker mount of /var" },
  { pattern: /-v\s+~\//, classification: "uncertain", reason: "Docker mount of home directory" },

  // Shell config modifications
  {
    pattern: /~\/\.(bashrc|zshrc|profile|bash_profile|zprofile)\b/,
    classification: "uncertain",
    reason: "Modifying shell config",
  },
  {
    pattern: /\/home\/[^/]+\/\.(bashrc|zshrc|profile)\b/,
    classification: "uncertain",
    reason: "Modifying shell config",
  },

  // System directories - only flag write operations (reads are OK)
  // Writing to /usr/local/bin specifically flagged as it installs commands
  { pattern: />\s*\/etc\//, classification: "uncertain", reason: "Writing to /etc" },
  { pattern: />\s*\/var\//, classification: "uncertain", reason: "Writing to /var" },
  {
    pattern: />\s*\/usr\/local\/bin\//,
    classification: "uncertain",
    reason: "Writing to /usr/local/bin",
  },
  { pattern: />\s*\/opt\//, classification: "uncertain", reason: "Writing to /opt" },
  {
    pattern: /\b(cp|mv|install)\b.*\s\/etc\//,
    classification: "uncertain",
    reason: "Copying/moving to /etc",
  },
  {
    pattern: /\b(cp|mv|install)\b.*\s\/var\//,
    classification: "uncertain",
    reason: "Copying/moving to /var",
  },
  {
    pattern: /\b(cp|mv|install)\b.*\s\/usr\/local\/bin\//,
    classification: "uncertain",
    reason: "Installing to /usr/local/bin",
  },
  {
    pattern: /\b(cp|mv|install)\b.*\s\/opt\//,
    classification: "uncertain",
    reason: "Copying/moving to /opt",
  },
  { pattern: /\brm\s.*\s\/etc\//, classification: "uncertain", reason: "Deleting from /etc" },
  { pattern: /\brm\s.*\s\/var\//, classification: "uncertain", reason: "Deleting from /var" },
  { pattern: /\brm\s.*\s\/usr\//, classification: "uncertain", reason: "Deleting from /usr" },
  { pattern: /\brm\s.*\s\/opt\//, classification: "uncertain", reason: "Deleting from /opt" },

  // Sensitive file/directory access (even read-only)
  { pattern: /\.ssh\//, classification: "uncertain", reason: "Accessing SSH keys" },
  { pattern: /\.gnupg\//, classification: "uncertain", reason: "Accessing GPG keys" },
  { pattern: /\.aws\//, classification: "uncertain", reason: "Accessing AWS credentials" },
  { pattern: /\.kube\//, classification: "uncertain", reason: "Accessing Kubernetes config" },
  {
    pattern: /\.env\.local\b/,
    classification: "uncertain",
    reason: "Accessing local secrets file",
  },
  {
    pattern: /\.env\.[^/]+\.local\b/,
    classification: "uncertain",
    reason: "Accessing local secrets file",
  },
  {
    pattern: /\.(pem|key|crt|p12|pfx|cer)\b/,
    classification: "uncertain",
    reason: "Accessing certificate/key file",
  },
  {
    pattern: /credentials\.json\b/,
    classification: "uncertain",
    reason: "Accessing credentials file",
  },
  {
    pattern: /secrets\.(json|ya?ml)\b/,
    classification: "uncertain",
    reason: "Accessing secrets file",
  },
  {
    pattern: /service[-_]?account.*\.json\b/,
    classification: "uncertain",
    reason: "Accessing service account credentials",
  },
  {
    pattern: /\.npmrc\b/,
    classification: "uncertain",
    reason: "Accessing npm config (may contain tokens)",
  },
  { pattern: /\.netrc\b/, classification: "uncertain", reason: "Accessing network credentials" },
  {
    pattern: /\.git-credentials\b/,
    classification: "uncertain",
    reason: "Accessing git credentials",
  },

  // Dangerous rm commands
  {
    pattern: /\brm\s+(-rf?|--recursive).*\/\s*$/,
    classification: "uncertain",
    reason: "Recursive delete at root",
  },
  {
    pattern: /\brm\s+(-rf?|--recursive)\s+~/,
    classification: "uncertain",
    reason: "Recursive delete in home",
  },

  // Environment modification
  {
    pattern: /\bexport\b.*>>.*rc\b/,
    classification: "uncertain",
    reason: "Persisting environment variable",
  },
  { pattern: /\blaunchctl\b/, classification: "uncertain", reason: "macOS service management" },
  { pattern: /\bsystemctl\b/, classification: "uncertain", reason: "Linux service management" },

  // Network/firewall
  { pattern: /\biptables\b/, classification: "uncertain", reason: "Firewall modification" },
  { pattern: /\bufw\b/, classification: "uncertain", reason: "Firewall modification" },

  // Dangerous write commands that could cause accidental damage
  { pattern: /\btee\s+\//, classification: "uncertain", reason: "tee writing to absolute path" },
  { pattern: /\btee\s+~/, classification: "uncertain", reason: "tee writing to home directory" },
  { pattern: /\bdd\b/, classification: "uncertain", reason: "dd can overwrite disks/files" },
  { pattern: /\bcrontab\b/, classification: "uncertain", reason: "Crontab modification" },
  { pattern: /\bat\b/, classification: "uncertain", reason: "Scheduled task (at command)" },
  { pattern: /\bmkfs\b/, classification: "uncertain", reason: "Filesystem creation" },
  { pattern: /\bfdisk\b/, classification: "uncertain", reason: "Disk partitioning" },
  { pattern: /\bparted\b/, classification: "uncertain", reason: "Disk partitioning" },
  { pattern: /\bshred\b/, classification: "uncertain", reason: "Secure file deletion" },
  { pattern: /\bkillall\b/, classification: "uncertain", reason: "Kill processes by name" },
  { pattern: /\bpkill\b/, classification: "uncertain", reason: "Kill processes by pattern" },

  // Prevent accidental recursive operations at root or home
  {
    pattern: /\brm\s+(-[rRf]+\s+)+\/\s*$/,
    classification: "uncertain",
    reason: "Recursive delete at root",
  },
  {
    pattern: /\brm\s+(-[rRf]+\s+)+\/$/,
    classification: "uncertain",
    reason: "Recursive delete at root",
  },
  {
    pattern: /\bchmod\s+-R\s+.*\/\s*$/,
    classification: "uncertain",
    reason: "Recursive chmod at root",
  },
  {
    pattern: /\bchown\s+-R\s+.*\/\s*$/,
    classification: "uncertain",
    reason: "Recursive chown at root",
  },
];

/**
 * Safe patterns - these can be auto-approved
 * Note: Most git commands don't have suggestedPattern because we handle git push specially
 * and don't want to blanket-approve all git commands
 */
const SAFE_PATTERNS: PatternRule[] = [
  // Git read-only operations - no pattern, let each be evaluated (git push needs special handling)
  {
    pattern: /^git\s+(status|log|diff|branch|show|blame|reflog|tag|remote|stash\s+list)\b/,
    classification: "safe",
    reason: "Read-only git operation",
  },

  // Git local operations (no push) - no pattern to avoid approving git push
  {
    pattern:
      /^git\s+(add|commit|checkout|switch|rebase|merge|cherry-pick|reset|stash(?!\s+list))\b/,
    classification: "safe",
    reason: "Local git operation",
  },
  { pattern: /^git\s+(fetch|pull)\b/, classification: "safe", reason: "Git fetch/pull" },
  { pattern: /^git\s+clone\b/, classification: "safe", reason: "Git clone" },

  // Package managers - local operations
  {
    pattern: /^bun\s+(test|build|run|install|add|remove|update|x)\b/,
    classification: "safe",
    reason: "Bun operation",
  },
  {
    pattern: /^npm\s+(test|run|install|ci|ls|outdated|audit)\b/,
    classification: "safe",
    reason: "npm operation",
  },
  {
    pattern: /^pnpm\s+(test|run|install|add|remove|update)\b/,
    classification: "safe",
    reason: "pnpm operation",
  },
  {
    pattern: /^yarn\s+(test|run|install|add|remove|upgrade)\b/,
    classification: "safe",
    reason: "yarn operation",
  },
  { pattern: /^npx\s+/, classification: "safe", reason: "npx execution" },

  // Build tools
  { pattern: /^(tsc|typescript)\b/, classification: "safe", reason: "TypeScript compiler" },
  { pattern: /^(eslint|prettier|biome)\b/, classification: "safe", reason: "Linter/formatter" },
  {
    pattern: /^(jest|vitest|mocha|pytest|cargo\s+test|go\s+test)\b/,
    classification: "safe",
    reason: "Test runner",
  },
  { pattern: /^(webpack|vite|esbuild|rollup|parcel)\b/, classification: "safe", reason: "Bundler" },
  { pattern: /^make\b/, classification: "safe", reason: "Make build" },
  {
    pattern: /^cargo\s+(build|run|check|clippy|fmt|test)\b/,
    classification: "safe",
    reason: "Cargo operation",
  },
  {
    pattern: /^go\s+(build|run|test|mod|fmt|vet)\b/,
    classification: "safe",
    reason: "Go operation",
  },

  // Read-only file operations
  {
    pattern: /^(ls|cat|head|tail|wc|file|stat)\b/,
    classification: "safe",
    reason: "Read-only file operation",
  },
  { pattern: /^(grep|rg|ag|ack)\b/, classification: "safe", reason: "Search operation" },
  { pattern: /^(find|fd)\b/, classification: "safe", reason: "Find files" },
  { pattern: /^(tree|du|df)\b/, classification: "safe", reason: "Directory info" },

  // Safe docker operations
  {
    pattern: /^docker\s+(build|images|ps|logs|inspect|exec)\b/,
    classification: "safe",
    reason: "Safe docker operation",
  },
  {
    pattern: /^docker-compose\s+(up|down|ps|logs|build)\b/,
    classification: "safe",
    reason: "Docker compose operation",
  },

  // Common dev operations
  {
    pattern: /^(echo|printf|pwd|which|whereis|type|env)\b/,
    classification: "safe",
    reason: "Info command",
  },
  { pattern: /^(mkdir|touch)\b/, classification: "safe", reason: "Create file/dir" },
  {
    pattern: /^(cp|mv|rm)\s+[^/]/,
    classification: "safe",
    reason: "File operation (relative path)",
  },
];

/**
 * Check command against known patterns (fast path)
 * Returns null if pattern is unknown and should be evaluated by haiku
 */
export function checkKnownPatterns(
  command: string,
  context: ProjectContext,
): EvaluationResult | null {
  const trimmedCommand = command.trim();
  const parseResult = parseCommand(trimmedCommand);

  // If command is too complex for simple regex evaluation, delegate to Haiku
  if (!parseResult.isSimple || parseResult.commands === null) {
    if (parseResult.complexReason) {
      console.error(`[cc-tool-guard] Delegating to Haiku: ${parseResult.complexReason}`);
    }
    return null;
  }

  return evaluateCommandChain(parseResult.commands, context);
}

/**
 * Evaluate a chain of commands, returning combined result
 */
function evaluateCommandChain(
  commands: string[],
  context: ProjectContext,
): EvaluationResult | null {
  const results: EvaluationResult[] = [];

  for (const cmd of commands) {
    const result = evaluateSingleCommand(cmd, context);
    if (result === null) {
      return null;
    }
    results.push(result);
  }

  // If any command is uncertain, the whole chain is uncertain
  const uncertainResult = results.find((r) => r.classification === "uncertain");
  if (uncertainResult) {
    return uncertainResult;
  }

  // Single command - return its result with pattern suggestion
  if (commands.length === 1) {
    return results[0]!;
  }

  // Multiple commands all safe - return safe but no pattern suggestion
  return { classification: "safe", reason: `All ${commands.length} chained commands are safe` };
}

/**
 * Evaluate a single command (no chaining) against known patterns
 */
function evaluateSingleCommand(command: string, context: ProjectContext): EvaluationResult | null {
  const trimmedCommand = command.trim();

  // Check dangerous patterns first
  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.pattern.test(trimmedCommand)) {
      return { classification: rule.classification, reason: rule.reason };
    }
  }

  // Special handling for git push
  if (/git\s+push\b/.test(trimmedCommand)) {
    return checkGitPush(trimmedCommand, context);
  }

  // Check for paths outside project
  const outsideProjectResult = checkPathsOutsideProject(trimmedCommand, context);
  if (outsideProjectResult) {
    return outsideProjectResult;
  }

  // Check safe patterns
  for (const rule of SAFE_PATTERNS) {
    if (rule.pattern.test(trimmedCommand)) {
      return {
        classification: rule.classification,
        reason: rule.reason,
        // suggestedPattern may be undefined - that's intentional
        suggestedPattern: rule.suggestedPattern,
      };
    }
  }

  // Unknown pattern - let haiku evaluate
  return null;
}

/**
 * Special handling for git push commands
 */
function checkGitPush(command: string, context: ProjectContext): EvaluationResult {
  const isForce = /--force\b|-f(?:\s|$)/.test(command);
  const targetBranch = extractPushTarget(command);

  // Check if pushing to main/master
  const isMainBranch =
    targetBranch === "main" ||
    targetBranch === "master" ||
    (!targetBranch && (context.currentBranch === "main" || context.currentBranch === "master"));

  if (isMainBranch) {
    if (isForce) {
      return { classification: "uncertain", reason: "Force push to main/master branch" };
    }
    return { classification: "uncertain", reason: "Push to main/master branch" };
  }

  // Force push to feature branch is ok, but don't add pattern since safety depends on branch context
  return {
    classification: "safe",
    reason: isForce ? "Force push to feature branch" : "Git push to feature branch",
    // No suggestedPattern - safety depends on current branch context
  };
}

/**
 * Extract the target branch from a git push command
 */
function extractPushTarget(command: string): string | null {
  // Match patterns like: git push origin main, git push -u origin feature
  const match = command.match(/git\s+push\s+(?:-[uf]\s+)?(?:\w+\s+)?(\S+)?$/);
  if (match && match[1] && !match[1].startsWith("-")) {
    return match[1];
  }
  return null;
}

/**
 * Read-only commands that are safe to run anywhere (except on sensitive files, caught earlier)
 */
const READ_ONLY_COMMANDS = [
  /^(cat|head|tail|less|more)\b/,
  /^(ls|dir|tree|du|df)\b/,
  /^(grep|rg|ag|ack|fgrep|egrep)\b/,
  /^(find|fd|locate)\b/,
  /^(file|stat|wc|md5|sha\d*sum|shasum)\b/,
  /^(strings|hexdump|xxd|od)\b/,
  /^(diff|cmp)\b/,
  /^(type|which|whereis|whatis|man|help)\b/,
  /^(env|printenv|set)\b/,
  /^(ps|top|htop|pgrep)\b/,
  /^(ifconfig|ip|netstat|ss|lsof|hostname)\b/,
  /^(uname|arch|whoami|id|groups)\b/,
  /^(date|cal|uptime)\b/,
];

/**
 * Check if command is read-only (doesn't modify anything)
 */
function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  return READ_ONLY_COMMANDS.some((pattern) => pattern.test(trimmed));
}

/**
 * Write commands that modify destinations
 */
const WRITE_COMMAND_PATTERNS = [
  // Delete operations
  /^(rm|rmdir)\b/,
  // Move/rename
  /^(mv)\b/,
  // Copy (destination is last arg usually)
  /^(cp)\b.*\s[^|<>]+$/,
  // Install command
  /^(install)\b/,
  // Create files
  /^(touch)\b/,
  // Create directories
  /^(mkdir)\b/,
  // Permission changes
  /^(chmod|chown|chgrp)\b/,
  // Link creation
  /^(ln)\b/,
  // Redirect output
  />/,
  // In-place editing
  /^(sed|awk|perl)\b.*-i/,
  // File truncation
  /^(truncate)\b/,
];

/**
 * Check if command is a write operation
 */
function isWriteCommand(command: string): boolean {
  const trimmed = command.trim();
  return WRITE_COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Check if command references paths outside the project
 * Only flags WRITE operations outside project - reads are allowed anywhere
 */
function checkPathsOutsideProject(
  command: string,
  context: ProjectContext,
): EvaluationResult | null {
  // Read-only commands are safe to run anywhere (sensitive files caught by DANGEROUS_PATTERNS)
  if (isReadOnlyCommand(command)) {
    // Let it proceed to safe pattern check
    return null;
  }

  // For write commands, check if they target paths outside project
  if (!isWriteCommand(command)) {
    // Not a clear write command - let Haiku evaluate
    return null;
  }

  const trimmedCommand = command.trim();

  // Detect home directory writes (~/something)
  // Exception: cp FROM home TO project is OK (checked separately)
  if (trimmedCommand.includes("~/")) {
    // Check if it's cp/mv FROM external TO local
    if (isCopyFromExternalToProject(trimmedCommand, context)) {
      // This is allowed
      return null;
    }
    return { classification: "uncertain", reason: "Write operation targeting home directory" };
  }

  // Detect absolute paths outside project
  const absolutePaths = trimmedCommand.match(/(?:^|\s)(\/[^\s]+)/g);
  if (absolutePaths) {
    for (const pathMatch of absolutePaths) {
      const path = pathMatch.trim();
      // Allow /tmp, /dev/null, and project paths
      if (
        !path.startsWith("/tmp") &&
        !path.startsWith(context.projectRoot) &&
        !path.startsWith("/dev/null") &&
        !path.startsWith("/dev/stdin") &&
        !path.startsWith("/dev/stdout") &&
        !path.startsWith("/dev/stderr")
      ) {
        // Check if it's cp/mv FROM external TO project (allowed)
        if (isCopyFromExternalToProject(trimmedCommand, context)) {
          return null;
        }
        return {
          classification: "uncertain",
          reason: `Write operation targeting path outside project: ${path}`,
        };
      }
    }
  }

  // Detect suspicious parent directory traversal for write ops
  // Threshold of 3 - most projects aren't more than 3 levels deep from home
  if (trimmedCommand.includes("../")) {
    const upCount = (trimmedCommand.match(/\.\.\//g) || []).length;
    if (upCount > 3) {
      return {
        classification: "uncertain",
        reason: "Excessive parent directory traversal in write operation (could escape project)",
      };
    }
  }

  return null;
}

/**
 * Check if a cp command is copying FROM external TO project (which is allowed)
 * Note: mv is NOT allowed because it modifies (deletes) the source file
 */
function isCopyFromExternalToProject(command: string, context: ProjectContext): boolean {
  // Only allow cp, NOT mv (mv deletes the source which is a modification)
  const cpMatch = command.match(/^cp\s+(.+)\s+(\S+)$/);
  if (!cpMatch) return false;

  const destination = cpMatch[2]!;

  // If destination is within project or relative (within cwd), it's allowed
  if (
    destination.startsWith(context.projectRoot) ||
    destination.startsWith("./") ||
    (!destination.startsWith("/") && !destination.startsWith("~"))
  ) {
    return true;
  }

  return false;
}
