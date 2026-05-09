/**
 * Command parsing utilities for handling shell command complexity
 *
 * Philosophy: Only auto-approve when we're ABSOLUTELY sure.
 * If a command is too complex to evaluate with simple regexes, delegate to Haiku.
 */

/**
 * Patterns that indicate command complexity beyond simple regex evaluation.
 * When these are present, we should delegate to Haiku for evaluation.
 */
const COMPLEX_PATTERNS = [
  // Command substitution $(...)
  /\$\(/,
  // Backtick command substitution
  /`/,
  // Variable expansion ${...}
  /\$\{/,
  // Here documents
  /<</,
  // eval command
  /\beval\b/,
  // exec command
  /\bexec\b/,
  // source command
  /\bsource\b/,
  // . (dot) sourcing
  /^\s*\./,
  // xargs can execute arbitrary commands
  /\bxargs\b/,
  // Line continuation
  /\\$/,
  // Multi-line command
  /\n/,
];

/**
 * Result of parsing a command
 */
export interface ParseResult {
  /** Whether the command is simple enough for regex evaluation */
  isSimple: boolean;
  /** Individual commands if successfully split, null if too complex */
  commands: string[] | null;
  /** Reason why command is complex (for logging) */
  complexReason?: string;
}

/**
 * Analyze a command and determine if it's simple enough for regex evaluation.
 * Returns parsed commands if simple, or indicates complexity if not.
 */
export function parseCommand(command: string): ParseResult {
  const trimmed = command.trim();

  // Check for complex patterns that should always go to Haiku
  for (const pattern of COMPLEX_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        isSimple: false,
        commands: null,
        complexReason: `Contains complex shell construct: ${pattern.source}`,
      };
    }
  }

  // Check if command has any chaining operators
  if (!hasChainOperators(trimmed)) {
    // Simple single command
    return { isSimple: true, commands: [trimmed] };
  }

  // Try to split the command on chain operators
  const splitResult = splitChainedCommands(trimmed);

  if (splitResult === null) {
    // Splitting failed - too complex
    return {
      isSimple: false,
      commands: null,
      complexReason: "Failed to safely split chained commands",
    };
  }

  return { isSimple: true, commands: splitResult };
}

/**
 * Check if command contains chain operators outside of quotes
 */
function hasChainOperators(command: string): boolean {
  // Quick check first
  if (!/[;&|]/.test(command)) {
    return false;
  }

  // Check if operators are outside quotes
  const tokens = tokenize(command);
  // Assume complex if tokenization fails
  if (tokens === null) return true;

  return tokens.some((t) => t.type === "operator");
}

/**
 * Token types for shell command parsing
 */
type TokenType = "word" | "operator" | "redirect";

interface Token {
  type: TokenType;
  value: string;
}

/**
 * Simple tokenizer that handles quotes and operators.
 * Returns null if the command is too complex to tokenize safely.
 */
function tokenize(command: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  let current = "";

  while (i < command.length) {
    const char = command[i];

    // Handle quotes
    if (char === '"' || char === "'") {
      const quote = char;
      current += char;
      i++;

      // Find closing quote
      while (i < command.length && command[i] !== quote) {
        if (command[i] === "\\" && quote === '"') {
          // Handle escapes in double quotes
          current += command[i];
          i++;
          if (i < command.length) {
            current += command[i];
            i++;
          }
        } else {
          current += command[i];
          i++;
        }
      }

      if (i >= command.length) {
        // Unclosed quote - too complex
        return null;
      }

      // Add closing quote
      current += command[i];
      i++;
      continue;
    }

    // Handle escape outside quotes
    if (char === "\\") {
      current += char;
      i++;
      if (i < command.length) {
        current += command[i];
        i++;
      }
      continue;
    }

    // Handle operators: &&, ||, ;, |, &
    if (char === "&" || char === "|" || char === ";") {
      // Flush current word
      if (current.trim()) {
        tokens.push({ type: "word", value: current.trim() });
        current = "";
      }

      // Check for && or ||
      if ((char === "&" || char === "|") && i + 1 < command.length && command[i + 1] === char) {
        tokens.push({ type: "operator", value: char + char });
        i += 2;
      } else if (char === "&") {
        // Background operator - treat as complex for now
        tokens.push({ type: "operator", value: "&" });
        i++;
      } else if (char === "|") {
        // Pipe
        tokens.push({ type: "operator", value: "|" });
        i++;
      } else {
        // Semicolon
        tokens.push({ type: "operator", value: ";" });
        i++;
      }
      continue;
    }

    // Handle redirects (>, >>, <)
    if (char === ">" || char === "<") {
      if (current.trim()) {
        tokens.push({ type: "word", value: current.trim() });
        current = "";
      }

      if (char === ">" && i + 1 < command.length && command[i + 1] === ">") {
        tokens.push({ type: "redirect", value: ">>" });
        i += 2;
      } else {
        tokens.push({ type: "redirect", value: char });
        i++;
      }
      continue;
    }

    // Regular character
    current += char;
    i++;
  }

  // Flush remaining
  if (current.trim()) {
    tokens.push({ type: "word", value: current.trim() });
  }

  return tokens;
}

/**
 * Split a command string into individual commands based on chain operators.
 * Returns null if splitting fails or is unsafe.
 */
function splitChainedCommands(command: string): string[] | null {
  const tokens = tokenize(command);

  if (tokens === null) {
    return null;
  }

  const commands: string[] = [];
  let currentCommand: string[] = [];

  for (const token of tokens) {
    if (token.type === "operator") {
      if (token.value === "&" && currentCommand.length > 0) {
        // Background operator - this is complex, delegate to Haiku
        return null;
      }

      // End of command (&&, ||, ;, |)
      if (currentCommand.length > 0) {
        commands.push(currentCommand.join(" "));
        currentCommand = [];
      }
    } else {
      currentCommand.push(token.value);
    }
  }

  // Don't forget the last command
  if (currentCommand.length > 0) {
    commands.push(currentCommand.join(" "));
  }

  // Filter out empty commands
  return commands.filter((cmd) => cmd.trim().length > 0);
}

/**
 * Check if a command is a pipe chain and return individual commands.
 * For pipes, we need to evaluate ALL commands in the chain since
 * any of them could have side effects.
 */
export function isPipeChain(command: string): boolean {
  const tokens = tokenize(command);
  if (tokens === null) return false;
  return tokens.some((t) => t.type === "operator" && t.value === "|");
}
