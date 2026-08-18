/**
 * Evaluates a formula expression against a row of data.
 *
 * Security: Uses a recursive-descent expression parser that only allows
 * whitelisted operations. No `new Function`, no `eval`, no prototype chain
 * access. The parser supports arithmetic, comparisons, logical operators,
 * ternary, property access (with a blocklist), and safe method calls.
 *
 * Timeout: Infinite loops are impossible since there are no loop constructs.
 * A call-count guard prevents excessive recursion or deeply nested expressions.
 */
export function evaluateFormula(expression: string, row: Record<string, unknown>): unknown {
  let opCount = 0;
  const MAX_OPS = 10_000;
  const guard = () => {
    if (++opCount > MAX_OPS) throw new FormulaError("Formula exceeded operation limit", expression);
  };

  try {
    const tokens = tokenize(expression);
    const parser = new Parser(tokens, row, guard);
    const result = parser.parseExpression();
    if (parser.pos < tokens.length) {
      throw new Error(`Unexpected token: ${tokens[parser.pos]!.value}`);
    }
    return result;
  } catch (err) {
    if (err instanceof FormulaError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new FormulaError(`Formula evaluation failed: ${message}`, expression);
  }
}

export class FormulaError extends Error {
  constructor(
    message: string,
    public readonly expression: string,
  ) {
    super(message);
    this.name = "FormulaError";
  }
}

// --- Tokenizer ---

type TokenKind =
  | "number"
  | "string"
  | "ident"
  | "op"
  | "paren"
  | "bracket"
  | "dot"
  | "comma"
  | "question"
  | "colon";

interface Token {
  kind: TokenKind;
  value: string;
}

const OPERATORS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "===",
  "!==",
  "==",
  "!=",
  "<=",
  ">=",
  "<",
  ">",
  "&&",
  "||",
  "??",
  "!",
]);

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    const ch = expr[i]!;

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Number literals (including decimals)
    if (/\d/.test(ch) || (ch === "." && i + 1 < expr.length && /\d/.test(expr[i + 1]!))) {
      let num = "";
      while (i < expr.length && /[\d.]/.test(expr[i]!)) {
        num += expr[i]!;
        i++;
      }
      tokens.push({ kind: "number", value: num });
      continue;
    }

    // String literals (single or double quoted)
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let str = "";
      i++; // skip opening quote
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === "\\") {
          i++;
          if (i >= expr.length) throw new Error("Unterminated string escape");
          const esc = expr[i]!;
          str +=
            esc === "n"
              ? "\n"
              : esc === "t"
                ? "\t"
                : esc === "\\"
                  ? "\\"
                  : esc === quote
                    ? quote
                    : `\\${esc}`;
        } else {
          str += expr[i];
        }
        i++;
      }
      if (i >= expr.length) throw new Error("Unterminated string literal");
      i++; // skip closing quote
      tokens.push({ kind: "string", value: str });
      continue;
    }

    // Template literals (backtick) — not supported
    if (ch === "`") {
      throw new Error("Template literals are not supported in formulas");
    }

    // Identifiers and keywords
    if (/[a-zA-Z_$]/.test(ch)) {
      let ident = "";
      while (i < expr.length && /[a-zA-Z0-9_$]/.test(expr[i]!)) {
        ident += expr[i]!;
        i++;
      }
      tokens.push({ kind: "ident", value: ident });
      continue;
    }

    // Multi-char operators
    if (i + 2 < expr.length) {
      const three = expr.slice(i, i + 3);
      if (OPERATORS.has(three)) {
        tokens.push({ kind: "op", value: three });
        i += 3;
        continue;
      }
    }
    if (i + 1 < expr.length) {
      const two = expr.slice(i, i + 2);
      if (OPERATORS.has(two)) {
        tokens.push({ kind: "op", value: two });
        i += 2;
        continue;
      }
    }

    // Single-char operators and punctuation
    if (OPERATORS.has(ch)) {
      tokens.push({ kind: "op", value: ch });
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ kind: "paren", value: ch });
      i++;
      continue;
    }
    if (ch === "[" || ch === "]") {
      tokens.push({ kind: "bracket", value: ch });
      i++;
      continue;
    }
    if (ch === ".") {
      tokens.push({ kind: "dot", value: "." });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "comma", value: "," });
      i++;
      continue;
    }
    if (ch === "?") {
      tokens.push({ kind: "question", value: "?" });
      i++;
      continue;
    }
    if (ch === ":") {
      tokens.push({ kind: "colon", value: ":" });
      i++;
      continue;
    }

    throw new Error(`Unexpected character: ${ch}`);
  }

  return tokens;
}

// --- Parser & Evaluator ---

/** Properties that must never be accessed from formula expressions. */
const BLOCKED_PROPERTIES = new Set([
  "constructor",
  "__proto__",
  "prototype",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/** Safe Math methods available in formulas. */
const SAFE_MATH: Record<string, (...args: number[]) => number> = {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  max: Math.max,
  min: Math.min,
  pow: Math.pow,
  sqrt: Math.sqrt,
  trunc: Math.trunc,
  sign: Math.sign,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
};

/** Safe string methods that can be called on string values. */
const SAFE_STRING_METHODS = new Set([
  "toLowerCase",
  "toUpperCase",
  "trim",
  "trimStart",
  "trimEnd",
  "startsWith",
  "endsWith",
  "includes",
  "indexOf",
  "lastIndexOf",
  "slice",
  "substring",
  "padStart",
  "padEnd",
  "repeat",
  "replace",
  "replaceAll",
  "split",
  "charAt",
  "charCodeAt",
  "at",
  "concat",
]);

/** Safe array methods that can be called on array values. */
const SAFE_ARRAY_METHODS = new Set([
  "length",
  "includes",
  "indexOf",
  "lastIndexOf",
  "join",
  "slice",
  "at",
  "flat",
  "concat",
]);

/** Safe number methods. */
const SAFE_NUMBER_METHODS = new Set(["toFixed", "toPrecision", "toString"]);

class Parser {
  pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly scope: Record<string, unknown>,
    private readonly guard: () => void,
  ) {}

  parseExpression(): unknown {
    return this.parseTernary();
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error("Unexpected end of expression");
    this.pos++;
    return t;
  }

  private expect(kind: TokenKind, value?: string): Token {
    const t = this.advance();
    if (t.kind !== kind || (value !== undefined && t.value !== value)) {
      throw new Error(`Expected ${value ?? kind}, got ${t.value}`);
    }
    return t;
  }

  // Ternary: expr ? expr : expr
  private parseTernary(): unknown {
    this.guard();
    const condition = this.parseNullishCoalescing();
    const t = this.peek();
    if (t?.kind === "question") {
      this.advance();
      const consequent = this.parseTernary();
      this.expect("colon");
      const alternate = this.parseTernary();
      return condition ? consequent : alternate;
    }
    return condition;
  }

  // Nullish coalescing: ??
  private parseNullishCoalescing(): unknown {
    let left = this.parseLogicalOr();
    while (this.peek()?.kind === "op" && this.peek()!.value === "??") {
      this.guard();
      this.advance();
      const right = this.parseLogicalOr();
      left = left ?? right;
    }
    return left;
  }

  // Logical OR: ||
  private parseLogicalOr(): unknown {
    let left = this.parseLogicalAnd();
    while (this.peek()?.kind === "op" && this.peek()!.value === "||") {
      this.guard();
      this.advance();
      const right = this.parseLogicalAnd();
      left = left || right;
    }
    return left;
  }

  // Logical AND: &&
  private parseLogicalAnd(): unknown {
    let left = this.parseEquality();
    while (this.peek()?.kind === "op" && this.peek()!.value === "&&") {
      this.guard();
      this.advance();
      const right = this.parseEquality();
      left = left && right;
    }
    return left;
  }

  // Equality: ==, !=, ===, !==
  private parseEquality(): unknown {
    let left = this.parseComparison();
    while (this.peek()?.kind === "op" && ["==", "!=", "===", "!=="].includes(this.peek()!.value)) {
      this.guard();
      const op = this.advance().value;
      const right = this.parseComparison();
      // oxlint-disable-next-line eqeqeq -- loose equality is intentional for formula semantics
      if (op === "==") left = left == right;
      // oxlint-disable-next-line eqeqeq -- loose equality is intentional for formula semantics
      else if (op === "!=") left = left != right;
      else if (op === "===") left = left === right;
      else left = left !== right;
    }
    return left;
  }

  // Comparison: <, >, <=, >=
  private parseComparison(): unknown {
    let left = this.parseAdditive();
    while (this.peek()?.kind === "op" && ["<", ">", "<=", ">="].includes(this.peek()!.value)) {
      this.guard();
      const op = this.advance().value;
      const right = this.parseAdditive();
      if (op === "<") left = (left as number) < (right as number);
      else if (op === ">") left = (left as number) > (right as number);
      else if (op === "<=") left = (left as number) <= (right as number);
      else left = (left as number) >= (right as number);
    }
    return left;
  }

  // Addition/subtraction: +, -
  private parseAdditive(): unknown {
    let left = this.parseMultiplicative();
    while (
      this.peek()?.kind === "op" &&
      (this.peek()!.value === "+" || this.peek()!.value === "-")
    ) {
      this.guard();
      const op = this.advance().value;
      const right = this.parseMultiplicative();
      if (op === "+") {
        left =
          typeof left === "string" || typeof right === "string"
            ? String(left) + String(right)
            : (left as number) + (right as number);
      } else {
        left = (left as number) - (right as number);
      }
    }
    return left;
  }

  // Multiplication/division/modulo: *, /, %
  private parseMultiplicative(): unknown {
    let left = this.parseUnary();
    while (
      this.peek()?.kind === "op" &&
      (this.peek()!.value === "*" || this.peek()!.value === "/" || this.peek()!.value === "%")
    ) {
      this.guard();
      const op = this.advance().value;
      const right = this.parseUnary();
      if (op === "*") left = (left as number) * (right as number);
      else if (op === "/") left = (left as number) / (right as number);
      else left = (left as number) % (right as number);
    }
    return left;
  }

  // Unary: -, +, !
  private parseUnary(): unknown {
    this.guard();
    const t = this.peek();
    if (t?.kind === "op") {
      if (t.value === "-") {
        this.advance();
        return -(this.parseUnary() as number);
      }
      if (t.value === "+") {
        this.advance();
        return Number(this.parseUnary());
      }
      if (t.value === "!") {
        this.advance();
        return !this.parseUnary();
      }
    }
    return this.parsePostfix();
  }

  // Postfix: property access (.prop, [expr]) and method calls (func(...args))
  private parsePostfix(): unknown {
    let value = this.parsePrimary();

    while (true) {
      const t = this.peek();
      if (!t) break;

      if (t.kind === "dot") {
        this.guard();
        this.advance();
        const prop = this.expect("ident").value;
        if (BLOCKED_PROPERTIES.has(prop)) {
          throw new Error(`Access to "${prop}" is not allowed`);
        }
        value = this.accessProperty(value, prop);
        continue;
      }

      if (t.kind === "bracket" && t.value === "[") {
        this.guard();
        this.advance();
        const index = this.parseExpression();
        this.expect("bracket", "]");
        if (typeof index === "string" && BLOCKED_PROPERTIES.has(index)) {
          throw new Error(`Access to "${index}" is not allowed`);
        }
        value = this.accessProperty(value, index);
        continue;
      }

      if (t.kind === "paren" && t.value === "(") {
        this.guard();
        // Value must be a safe callable — resolved during property access
        if (typeof value !== "function") {
          throw new Error("Value is not callable");
        }
        this.advance();
        const args = this.parseArgList();
        this.expect("paren", ")");
        value = value(...args);
        continue;
      }

      break;
    }

    return value;
  }

  private parseArgList(): unknown[] {
    const args: unknown[] = [];
    if (this.peek()?.kind === "paren" && this.peek()!.value === ")") return args;

    args.push(this.parseExpression());
    while (this.peek()?.kind === "comma") {
      this.advance();
      args.push(this.parseExpression());
    }
    return args;
  }

  // Primary: literals, identifiers, parenthesized expressions, array literals
  private parsePrimary(): unknown {
    const t = this.peek();
    if (!t) throw new Error("Unexpected end of expression");

    // Number
    if (t.kind === "number") {
      this.advance();
      return Number(t.value);
    }

    // String
    if (t.kind === "string") {
      this.advance();
      return t.value;
    }

    // Parenthesized expression
    if (t.kind === "paren" && t.value === "(") {
      this.advance();
      const value = this.parseExpression();
      this.expect("paren", ")");
      return value;
    }

    // Array literal
    if (t.kind === "bracket" && t.value === "[") {
      this.advance();
      const elements: unknown[] = [];
      if (!(this.peek()?.kind === "bracket" && this.peek()!.value === "]")) {
        elements.push(this.parseExpression());
        while (this.peek()?.kind === "comma") {
          this.advance();
          elements.push(this.parseExpression());
        }
      }
      this.expect("bracket", "]");
      return elements;
    }

    // Identifiers and keywords
    if (t.kind === "ident") {
      this.advance();
      switch (t.value) {
        case "true":
          return true;
        case "false":
          return false;
        case "null":
          return null;
        case "undefined":
          return undefined;
        case "NaN":
          return NaN;
        case "Infinity":
          return Infinity;
        case "Math":
          return this.createMathProxy();
        case "Number":
          return this.createNumberProxy();
        case "String":
          return this.createStringProxy();
        default:
          if (BLOCKED_PROPERTIES.has(t.value)) {
            throw new Error(`Access to "${t.value}" is not allowed`);
          }
          if (!(t.value in this.scope)) {
            throw new Error(`Unknown variable: ${t.value}`);
          }
          return this.scope[t.value];
      }
    }

    throw new Error(`Unexpected token: ${t.value}`);
  }

  private accessProperty(obj: unknown, prop: unknown): unknown {
    if (obj === null || obj === undefined) {
      throw new Error(`Cannot read property "${String(prop)}" of ${String(obj)}`);
    }

    const key = typeof prop === "number" ? prop : String(prop);

    // Array property access
    if (Array.isArray(obj)) {
      if (typeof key === "number") return obj[key];
      if (key === "length") return obj.length;
      if (typeof key === "string" && SAFE_ARRAY_METHODS.has(key)) {
        const method = obj[key as keyof unknown[]];
        if (typeof method === "function") return method.bind(obj);
      }
      throw new Error(`Array property "${key}" is not allowed`);
    }

    // String property access
    if (typeof obj === "string") {
      if (key === "length") return obj.length;
      if (typeof key === "number") return obj[key];
      if (typeof key === "string" && SAFE_STRING_METHODS.has(key)) {
        const method = obj[key as keyof string];
        if (typeof method === "function")
          return (method as (...args: unknown[]) => unknown).bind(obj);
      }
      throw new Error(`String property "${key}" is not allowed`);
    }

    // Number property access
    if (typeof obj === "number") {
      if (typeof key === "string" && SAFE_NUMBER_METHODS.has(key)) {
        const method = obj[key as keyof number];
        if (typeof method === "function")
          return (method as (...args: unknown[]) => unknown).bind(obj);
      }
      throw new Error(`Number property "${key}" is not allowed`);
    }

    // Plain object property access (row data, hydrated option objects, etc.)
    if (typeof obj === "object") {
      if (typeof key === "string" && BLOCKED_PROPERTIES.has(key)) {
        throw new Error(`Access to "${key}" is not allowed`);
      }
      return (obj as Record<string, unknown>)[String(key)];
    }

    throw new Error(`Cannot access property "${String(key)}" on ${typeof obj}`);
  }

  private createMathProxy(): Record<string, unknown> {
    const proxy: Record<string, unknown> = {
      PI: Math.PI,
      E: Math.E,
      LN2: Math.LN2,
      LN10: Math.LN10,
      SQRT2: Math.SQRT2,
    };
    for (const [name, fn] of Object.entries(SAFE_MATH)) {
      proxy[name] = fn;
    }
    return proxy;
  }

  private createNumberProxy(): (value: unknown) => number {
    const fn = (value: unknown) => Number(value);
    fn.isFinite = Number.isFinite;
    fn.isInteger = Number.isInteger;
    fn.isNaN = Number.isNaN;
    fn.parseFloat = Number.parseFloat;
    fn.parseInt = Number.parseInt;
    return fn;
  }

  private createStringProxy(): (value: unknown) => string {
    return (value: unknown) => String(value);
  }
}
