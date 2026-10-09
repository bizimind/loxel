/**
 * Evaluates a formula expression against a row of data.
 *
 * Security: The expression is parsed into an AST by a recursive-descent parser
 * that only accepts a whitelisted subset of JavaScript expression syntax, then
 * evaluated by a tree walker. No `new Function`, no `eval`, no prototype chain
 * access. Supported: arithmetic, comparisons, logical operators (short-circuiting),
 * ternary, property access (with a blocklist), array literals, and safe method
 * calls on strings, numbers, arrays, plus `Math`, `Number`, and `String`.
 *
 * Timeout: Infinite loops are impossible since there are no loop constructs.
 * A node-count guard bounds parsing and evaluation of deeply nested expressions.
 */
export function evaluateFormula(expression: string, row: Record<string, unknown>): unknown {
  let opCount = 0;
  const MAX_OPS = 10_000;
  const guard = () => {
    if (++opCount > MAX_OPS) throw new FormulaError("Formula exceeded operation limit", expression);
  };

  try {
    const tokens = tokenize(expression);
    const parser = new Parser(tokens, guard);
    const ast = parser.parseExpression();
    if (parser.pos < tokens.length) {
      throw new Error(`Unexpected token: ${tokens[parser.pos]!.value}`);
    }
    return new Evaluator(row, guard).evaluate(ast);
  } catch (err) {
    if (err instanceof FormulaError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new FormulaError(`Formula evaluation failed: ${message}`, expression, { cause: err });
  }
}

export class FormulaError extends Error {
  constructor(
    message: string,
    public readonly expression: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
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

/** Single-character escapes, decoded with JavaScript string-literal semantics. */
const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "/": "/",
};

function readHexEscape(
  expr: string,
  start: number,
  length: number,
): { text: string; next: number } {
  const hex = expr.slice(start, start + length);
  if (hex.length !== length || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(
      `Invalid hex escape in string literal: \\${expr.slice(start - 1, start + length)}`,
    );
  }
  return { text: String.fromCodePoint(Number.parseInt(hex, 16)), next: start + length };
}

/**
 * Decodes the escape sequence whose backslash sits at `start - 1`, following JavaScript
 * semantics: named escapes, `\xHH`, `\uXXXX`, `\u{...}`, and any other escaped character
 * standing for itself.
 */
function readStringEscape(expr: string, start: number): { text: string; next: number } {
  if (start >= expr.length) throw new Error("Unterminated string escape");
  const esc = expr[start]!;
  const simple = SIMPLE_ESCAPES[esc];
  if (simple !== undefined) return { text: simple, next: start + 1 };
  if (esc === "x") return readHexEscape(expr, start + 1, 2);
  if (esc === "u" && expr[start + 1] !== "{") return readHexEscape(expr, start + 1, 4);
  if (esc === "u") {
    const close = expr.indexOf("}", start + 2);
    const hex = close === -1 ? "" : expr.slice(start + 2, close);
    const codePoint = /^[0-9a-fA-F]+$/.test(hex) ? Number.parseInt(hex, 16) : Number.NaN;
    if (!(codePoint <= 0x10ffff)) {
      throw new Error(
        `Invalid unicode escape in string literal: \\${expr.slice(start, start + 10)}`,
      );
    }
    return { text: String.fromCodePoint(codePoint), next: close + 1 };
  }
  return { text: esc, next: start + 1 };
}

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

    // Number literals: digits with at most one decimal point (`1`, `1.5`, `.5`, `10.`).
    // A second dot followed by a digit (`1.2.3`, `1..2`) is a malformed literal; a dot followed
    // by an identifier (`1.5.toFixed(0)`) is member access and left to the punctuation scan.
    if (/\d/.test(ch) || (ch === "." && i + 1 < expr.length && /\d/.test(expr[i + 1]!))) {
      const start = i;
      while (i < expr.length && /\d/.test(expr[i]!)) i++;
      if (expr[i] === ".") {
        i++;
        while (i < expr.length && /\d/.test(expr[i]!)) i++;
      }
      if (expr[i] === "." && i + 1 < expr.length && /\d/.test(expr[i + 1]!)) {
        throw new Error(`Malformed number literal: ${expr.slice(start, i + 2)}`);
      }
      tokens.push({ kind: "number", value: expr.slice(start, i) });
      continue;
    }

    // String literals (single or double quoted)
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let str = "";
      i++; // skip opening quote
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === "\\") {
          const { text, next } = readStringEscape(expr, i + 1);
          str += text;
          i = next;
          continue;
        }
        str += expr[i];
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

// --- AST ---

type UnaryOp = "-" | "+" | "!";
type LogicalOp = "&&" | "||" | "??";
type BinaryOp = "==" | "!=" | "===" | "!==" | "<" | ">" | "<=" | ">=" | "+" | "-" | "*" | "/" | "%";

type Node =
  | { type: "literal"; value: unknown }
  | { type: "identifier"; name: string }
  | { type: "array"; elements: Node[] }
  | { type: "unary"; op: UnaryOp; operand: Node }
  | { type: "binary"; op: BinaryOp; left: Node; right: Node }
  | { type: "logical"; op: LogicalOp; left: Node; right: Node }
  | { type: "conditional"; test: Node; consequent: Node; alternate: Node }
  | { type: "member"; object: Node; property: Node }
  | { type: "call"; callee: Node; args: Node[] };

const EQUALITY_OPS: ReadonlySet<BinaryOp> = new Set(["==", "!=", "===", "!=="]);
const COMPARISON_OPS: ReadonlySet<BinaryOp> = new Set(["<", ">", "<=", ">="]);
const ADDITIVE_OPS: ReadonlySet<BinaryOp> = new Set(["+", "-"]);
const MULTIPLICATIVE_OPS: ReadonlySet<BinaryOp> = new Set(["*", "/", "%"]);

function isBinaryOp(value: string, ops: ReadonlySet<BinaryOp>): value is BinaryOp {
  return (ops as ReadonlySet<string>).has(value);
}

// --- Parser ---

/**
 * Builds an AST from the token stream. Parsing never evaluates anything, so
 * untaken ternary/logical branches are consumed without side effects.
 */
/** Maximum expression nesting depth; keeps recursive descent well within the call stack. */
const MAX_DEPTH = 100;

class Parser {
  pos = 0;
  private depth = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly guard: () => void,
  ) {}

  parseExpression(): Node {
    return this.parseConditional();
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private peekOp(ops: ReadonlySet<BinaryOp>): BinaryOp | undefined {
    const t = this.peek();
    return t?.kind === "op" && isBinaryOp(t.value, ops) ? t.value : undefined;
  }

  private peekIs(kind: TokenKind, value: string): boolean {
    const t = this.peek();
    return t?.kind === kind && t.value === value;
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

  // Conditional: expr ? expr : expr
  private parseConditional(): Node {
    this.guard();
    if (++this.depth > MAX_DEPTH) throw new Error("Formula nesting too deep");
    try {
      const test = this.parseNullishCoalescing();
      if (this.peek()?.kind !== "question") return test;
      this.advance();
      const consequent = this.parseConditional();
      this.expect("colon");
      const alternate = this.parseConditional();
      return { type: "conditional", test, consequent, alternate };
    } finally {
      this.depth--;
    }
  }

  // Nullish coalescing: ??
  private parseNullishCoalescing(): Node {
    return this.parseLogical("??", () => this.parseLogicalOr());
  }

  // Logical OR: ||
  private parseLogicalOr(): Node {
    return this.parseLogical("||", () => this.parseLogicalAnd());
  }

  // Logical AND: &&
  private parseLogicalAnd(): Node {
    return this.parseLogical("&&", () => this.parseEquality());
  }

  /** Left-associative chain of a single short-circuiting operator. */
  private parseLogical(op: LogicalOp, parseOperand: () => Node): Node {
    let left = parseOperand();
    while (this.peekIs("op", op)) {
      this.guard();
      this.advance();
      const right = parseOperand();
      left = { type: "logical", op, left, right };
    }
    return left;
  }

  /** Left-associative chain of binary operators from one precedence level. */
  private parseBinary(ops: ReadonlySet<BinaryOp>, parseOperand: () => Node): Node {
    let left = parseOperand();
    for (let op = this.peekOp(ops); op !== undefined; op = this.peekOp(ops)) {
      this.guard();
      this.advance();
      const right = parseOperand();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  // Equality: ==, !=, ===, !==
  private parseEquality(): Node {
    return this.parseBinary(EQUALITY_OPS, () => this.parseComparison());
  }

  // Comparison: <, >, <=, >=
  private parseComparison(): Node {
    return this.parseBinary(COMPARISON_OPS, () => this.parseAdditive());
  }

  // Addition/subtraction: +, -
  private parseAdditive(): Node {
    return this.parseBinary(ADDITIVE_OPS, () => this.parseMultiplicative());
  }

  // Multiplication/division/modulo: *, /, %
  private parseMultiplicative(): Node {
    return this.parseBinary(MULTIPLICATIVE_OPS, () => this.parseUnary());
  }

  // Unary: -, +, !
  private parseUnary(): Node {
    this.guard();
    const t = this.peek();
    if (t?.kind === "op" && (t.value === "-" || t.value === "+" || t.value === "!")) {
      this.advance();
      return { type: "unary", op: t.value, operand: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  // Postfix: property access (.prop, [expr]) and calls (func(...args))
  private parsePostfix(): Node {
    let node = this.parsePrimary();

    while (true) {
      const t = this.peek();
      if (!t) break;

      if (t.kind === "dot") {
        this.guard();
        this.advance();
        const prop = this.expect("ident").value;
        node = { type: "member", object: node, property: { type: "literal", value: prop } };
        continue;
      }

      if (t.kind === "bracket" && t.value === "[") {
        this.guard();
        this.advance();
        const property = this.parseExpression();
        this.expect("bracket", "]");
        node = { type: "member", object: node, property };
        continue;
      }

      if (t.kind === "paren" && t.value === "(") {
        this.guard();
        this.advance();
        const args = this.parseList("paren", ")");
        node = { type: "call", callee: node, args };
        continue;
      }

      break;
    }

    return node;
  }

  /** Parses a comma-separated expression list up to (and consuming) the closing token. */
  private parseList(closeKind: TokenKind, closeValue: string): Node[] {
    const items: Node[] = [];
    if (!this.peekIs(closeKind, closeValue)) {
      items.push(this.parseExpression());
      while (this.peek()?.kind === "comma") {
        this.advance();
        items.push(this.parseExpression());
      }
    }
    this.expect(closeKind, closeValue);
    return items;
  }

  // Primary: literals, identifiers, parenthesized expressions, array literals
  private parsePrimary(): Node {
    const t = this.peek();
    if (!t) throw new Error("Unexpected end of expression");

    if (t.kind === "number") {
      this.advance();
      return { type: "literal", value: Number(t.value) };
    }

    if (t.kind === "string") {
      this.advance();
      return { type: "literal", value: t.value };
    }

    if (t.kind === "paren" && t.value === "(") {
      this.advance();
      const node = this.parseExpression();
      this.expect("paren", ")");
      return node;
    }

    if (t.kind === "bracket" && t.value === "[") {
      this.advance();
      return { type: "array", elements: this.parseList("bracket", "]") };
    }

    if (t.kind === "ident") {
      this.advance();
      return { type: "identifier", name: t.value };
    }

    throw new Error(`Unexpected token: ${t.value}`);
  }
}

// --- Evaluator ---

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

/**
 * Built-in namespaces exposed to formulas. `Math` is a plain object of constants and
 * safe methods; `Number` and `String` are callable (`Number("3")`) and `Number`
 * additionally carries static helpers. `accessProperty` exposes only their own
 * enumerable properties and throws on anything else (see `BUILTIN_NAMESPACES`).
 */
const MATH_NAMESPACE = Object.freeze({
  PI: Math.PI,
  E: Math.E,
  LN2: Math.LN2,
  LN10: Math.LN10,
  LOG2E: Math.LOG2E,
  LOG10E: Math.LOG10E,
  SQRT2: Math.SQRT2,
  SQRT1_2: Math.SQRT1_2,
  ...SAFE_MATH,
});

const NUMBER_NAMESPACE = Object.freeze(
  Object.assign((value: unknown) => Number(value), {
    isFinite: Number.isFinite,
    isInteger: Number.isInteger,
    isNaN: Number.isNaN,
    parseFloat: Number.parseFloat,
    parseInt: Number.parseInt,
  }),
);

const STRING_NAMESPACE = Object.freeze((value: unknown) => String(value));

/** Namespace objects whose members are read strictly: a miss throws, never `undefined`. */
const BUILTIN_NAMESPACES: ReadonlySet<object> = new Set<object>([
  MATH_NAMESPACE,
  NUMBER_NAMESPACE,
  STRING_NAMESPACE,
]);

const BUILTINS: Readonly<Record<string, unknown>> = Object.freeze({
  true: true,
  false: false,
  null: null,
  undefined,
  NaN,
  Infinity,
  Math: MATH_NAMESPACE,
  Number: NUMBER_NAMESPACE,
  String: STRING_NAMESPACE,
});

/**
 * Canonical numeric index strings (e.g. `"1"` from a text column) are treated as numeric
 * indices so `tags["1"]` behaves like `tags[1]`. Such strings can never name a prototype member.
 */
function normalizePropertyKey(prop: unknown): string | number {
  if (typeof prop === "number") return prop;
  const key = String(prop);
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && String(n) === key ? n : key;
}

class Evaluator {
  constructor(
    private readonly scope: Record<string, unknown>,
    private readonly guard: () => void,
  ) {}

  evaluate(node: Node): unknown {
    this.guard();
    switch (node.type) {
      case "literal":
        return node.value;
      case "identifier":
        return this.resolveIdentifier(node.name);
      case "array":
        return node.elements.map((el) => this.evaluate(el));
      case "unary":
        return this.evaluateUnary(node.op, this.evaluate(node.operand));
      case "binary":
        return this.evaluateBinary(node.op, this.evaluate(node.left), this.evaluate(node.right));
      case "logical":
        return this.evaluateLogical(node);
      case "conditional":
        return this.evaluate(node.test)
          ? this.evaluate(node.consequent)
          : this.evaluate(node.alternate);
      case "member":
        return this.accessProperty(this.evaluate(node.object), this.evaluate(node.property));
      case "call": {
        const callee = this.evaluate(node.callee);
        // Only functions handed out by accessProperty/BUILTINS are reachable here.
        if (typeof callee !== "function") throw new Error("Value is not callable");
        const args = node.args.map((arg) => this.evaluate(arg));
        return callee(...args);
      }
      default: {
        const _exhaustive: never = node;
        return _exhaustive;
      }
    }
  }

  private resolveIdentifier(name: string): unknown {
    if (BLOCKED_PROPERTIES.has(name)) throw new Error(`Access to "${name}" is not allowed`);
    if (Object.hasOwn(BUILTINS, name)) return BUILTINS[name];
    if (!Object.hasOwn(this.scope, name)) throw new Error(`Unknown variable: ${name}`);
    return this.scope[name];
  }

  private evaluateUnary(op: UnaryOp, value: unknown): unknown {
    switch (op) {
      case "-":
        return -(value as number);
      case "+":
        return Number(value);
      case "!":
        return !value;
      default: {
        const _exhaustive: never = op;
        return _exhaustive;
      }
    }
  }

  // Short-circuits: the right operand is only evaluated when needed.
  private evaluateLogical(node: Extract<Node, { type: "logical" }>): unknown {
    const left = this.evaluate(node.left);
    switch (node.op) {
      case "&&":
        return left && this.evaluate(node.right);
      case "||":
        return left || this.evaluate(node.right);
      case "??":
        return left ?? this.evaluate(node.right);
      default: {
        const _exhaustive: never = node.op;
        return _exhaustive;
      }
    }
  }

  private evaluateBinary(op: BinaryOp, left: unknown, right: unknown): unknown {
    switch (op) {
      case "==":
        // oxlint-disable-next-line eqeqeq -- loose equality is intentional for formula semantics
        return left == right;
      case "!=":
        // oxlint-disable-next-line eqeqeq -- loose equality is intentional for formula semantics
        return left != right;
      case "===":
        return left === right;
      case "!==":
        return left !== right;
      case "<":
        return (left as number) < (right as number);
      case ">":
        return (left as number) > (right as number);
      case "<=":
        return (left as number) <= (right as number);
      case ">=":
        return (left as number) >= (right as number);
      case "+":
        return typeof left === "string" || typeof right === "string"
          ? String(left) + String(right)
          : (left as number) + (right as number);
      case "-":
        return (left as number) - (right as number);
      case "*":
        return (left as number) * (right as number);
      case "/":
        return (left as number) / (right as number);
      case "%":
        return (left as number) % (right as number);
      default: {
        const _exhaustive: never = op;
        return _exhaustive;
      }
    }
  }

  private accessProperty(obj: unknown, prop: unknown): unknown {
    if (obj === null || obj === undefined) {
      throw new Error(`Cannot read property "${String(prop)}" of ${String(obj)}`);
    }

    const key = normalizePropertyKey(prop);
    if (typeof key === "string" && BLOCKED_PROPERTIES.has(key)) {
      throw new Error(`Access to "${key}" is not allowed`);
    }

    if (Array.isArray(obj)) {
      if (typeof key === "number") return obj[key];
      if (key === "length") return obj.length;
      if (SAFE_ARRAY_METHODS.has(key)) {
        const method = obj[key as keyof unknown[]];
        if (typeof method === "function") return method.bind(obj);
      }
      throw new Error(`Array property "${key}" is not allowed`);
    }

    if (typeof obj === "string") {
      if (key === "length") return obj.length;
      if (typeof key === "number") return obj[key];
      if (SAFE_STRING_METHODS.has(key)) {
        const method = obj[key as keyof string];
        if (typeof method === "function")
          return (method as (...args: unknown[]) => unknown).bind(obj);
      }
      throw new Error(`String property "${key}" is not allowed`);
    }

    if (typeof obj === "number") {
      if (typeof key === "string" && SAFE_NUMBER_METHODS.has(key)) {
        const method = obj[key as keyof number];
        if (typeof method === "function")
          return (method as (...args: unknown[]) => unknown).bind(obj);
      }
      throw new Error(`Number property "${key}" is not allowed`);
    }

    // Builtin namespaces (`Math.max`, `Number.isFinite`) and any other function value: only
    // own enumerable properties, never inherited Object.prototype/Function.prototype members
    // like `call`/`apply`/`bind`. Unlike row data, an unknown member throws instead of
    // yielding `undefined`, matching the primitive branches above.
    if (typeof obj === "function" || BUILTIN_NAMESPACES.has(obj)) {
      const members = obj as Record<string, unknown>;
      if (typeof key === "string" && Object.keys(members).includes(key)) return members[key];
      throw new Error(`Property "${String(key)}" is not allowed`);
    }

    // Plain object property access (row data, hydrated option objects, etc.).
    // Own properties only, so inherited Object.prototype members stay unreachable.
    if (typeof obj === "object") {
      const record = obj as Record<string, unknown>;
      return Object.hasOwn(record, key) ? record[key] : undefined;
    }

    throw new Error(`Cannot access property "${String(key)}" on ${typeof obj}`);
  }
}
