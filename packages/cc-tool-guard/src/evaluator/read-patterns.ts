import type { ProjectContext, EvaluationResult } from "../types.ts";

interface SensitivePattern {
  pattern: RegExp;
  reason: string;
}

/**
 * Patterns for sensitive files that should always require user confirmation
 */
const SENSITIVE_FILE_PATTERNS: SensitivePattern[] = [
  // Local environment files (NOT all .env - only .local variants contain secrets)
  { pattern: /\.env\.local$/, reason: "Local environment file with secrets" },
  { pattern: /\.env\.[^/]+\.local$/, reason: "Local environment file with secrets" },
  { pattern: /\.env\.development\.local$/, reason: "Local development secrets" },
  { pattern: /\.env\.production\.local$/, reason: "Local production secrets" },

  // Certificate and key files
  { pattern: /\.pem$/, reason: "Certificate/key file" },
  { pattern: /\.key$/, reason: "Private key file" },
  { pattern: /\.crt$/, reason: "Certificate file" },
  { pattern: /\.p12$/, reason: "PKCS12 certificate" },
  { pattern: /\.pfx$/, reason: "PFX certificate" },
  { pattern: /\.cer$/, reason: "Certificate file" },

  // SSH directory
  { pattern: /[/\\]\.ssh[/\\]/, reason: "SSH directory" },
  { pattern: /[/\\]\.ssh$/, reason: "SSH directory" },

  // Cloud credentials
  { pattern: /[/\\]\.aws[/\\]/, reason: "AWS credentials directory" },
  { pattern: /[/\\]\.aws$/, reason: "AWS credentials directory" },
  { pattern: /[/\\]\.gcloud[/\\]/, reason: "Google Cloud credentials" },
  { pattern: /[/\\]\.azure[/\\]/, reason: "Azure credentials" },

  // Kubernetes config
  { pattern: /[/\\]\.kube[/\\]/, reason: "Kubernetes config" },
  { pattern: /[/\\]\.kube$/, reason: "Kubernetes config" },

  // GPG keys
  { pattern: /[/\\]\.gnupg[/\\]/, reason: "GPG keys directory" },
  { pattern: /[/\\]\.gnupg$/, reason: "GPG keys directory" },

  // Common secrets files
  { pattern: /secrets\.json$/, reason: "Secrets file" },
  { pattern: /secrets\.ya?ml$/, reason: "Secrets file" },
  { pattern: /credentials\.json$/, reason: "Credentials file" },
  { pattern: /service[-_]?account.*\.json$/, reason: "Service account credentials" },

  // Auth tokens in config
  { pattern: /\.npmrc$/, reason: "npm config (may contain tokens)" },
  { pattern: /\.pypirc$/, reason: "PyPI config (may contain tokens)" },
  { pattern: /\.netrc$/, reason: "Network credentials file" },

  // Database files with potential sensitive data
  { pattern: /\.sqlite3?$/, reason: "SQLite database" },

  // Password/secret stores
  { pattern: /[/\\]\.password-store[/\\]/, reason: "Password store" },
  { pattern: /\.keychain/, reason: "Keychain file" },

  // Private configuration that often has secrets
  { pattern: /\.docker[/\\]config\.json$/, reason: "Docker config (may contain tokens)" },
  { pattern: /\.git-credentials$/, reason: "Git credentials file" },

  // Shell history files (may contain secrets typed in commands)
  {
    pattern: /\.(bash_history|zsh_history|sh_history)$/,
    reason: "Shell history (may contain secrets)",
  },
  { pattern: /\.histfile$/, reason: "Shell history file" },
  { pattern: /\.python_history$/, reason: "Python REPL history" },
  { pattern: /\.node_repl_history$/, reason: "Node REPL history" },
  { pattern: /\.psql_history$/, reason: "PostgreSQL history" },
  { pattern: /\.mysql_history$/, reason: "MySQL history" },
  { pattern: /\.rediscli_history$/, reason: "Redis CLI history" },

  // Terraform state (often contains secrets)
  { pattern: /\.tfstate$/, reason: "Terraform state (may contain secrets)" },
  { pattern: /\.tfstate\.backup$/, reason: "Terraform state backup" },

  // Additional token files
  { pattern: /\.hub$/, reason: "GitHub Hub CLI config" },
  { pattern: /\.github_token$/, reason: "GitHub token file" },
  { pattern: /\.gitlab_token$/, reason: "GitLab token file" },
];

/**
 * Directories that are always safe to read from
 */
const SAFE_DIRECTORIES = [
  "/tmp",
  "/dev/null",
  // Documentation, common data
  "/usr/share/",
  "/usr/local/share/",
];

/**
 * Check if a file path matches sensitive patterns
 * Returns EvaluationResult if sensitive, null otherwise
 */
export function checkSensitiveFile(
  filePath: string,
  _context: ProjectContext,
): EvaluationResult | null {
  const normalizedPath = filePath.replace(/\\/g, "/");

  // Check against sensitive patterns
  for (const { pattern, reason } of SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(normalizedPath)) {
      return { classification: "uncertain", reason: reason };
    }
  }

  return null;
}

/**
 * Check if file is within the project or in a safe location
 */
export function checkReadLocation(
  filePath: string,
  context: ProjectContext,
): EvaluationResult | null {
  const normalizedPath = filePath.replace(/\\/g, "/");

  // Files within project are safe (unless they're sensitive files - checked separately)
  if (normalizedPath.startsWith(context.projectRoot)) {
    return { classification: "safe", reason: "File within project" };
  }

  // Safe system directories
  for (const safeDir of SAFE_DIRECTORIES) {
    if (normalizedPath.startsWith(safeDir)) {
      return { classification: "safe", reason: `File in safe system directory: ${safeDir}` };
    }
  }

  // Files outside project - safe to READ (not sensitive), but no pattern stored
  // This is because reading other project code, tool settings, etc. is allowed
  return {
    classification: "safe",
    reason: "Read-only access to external file",
    // No suggestedPattern - we allow reads on a case-by-case basis, not blanket approval
  };
}

/**
 * Evaluate a Read tool request
 * First checks for sensitive files, then location
 */
export function evaluateReadRequest(filePath: string, context: ProjectContext): EvaluationResult {
  // First check if it's a sensitive file (always needs approval)
  const sensitiveResult = checkSensitiveFile(filePath, context);
  if (sensitiveResult) {
    return sensitiveResult;
  }

  // Check location and return appropriate result
  return checkReadLocation(filePath, context)!;
}
