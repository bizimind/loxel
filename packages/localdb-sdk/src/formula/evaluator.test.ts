import { describe, expect, it } from "bun:test";

import { evaluateFormula, FormulaError } from "./evaluator";

const row = {
  price: 10,
  qty: 3,
  status: "open",
  name: "  Widget  ",
  tags: ["a", "b"],
  owner: { name: "Ori", age: 40 },
  missing: null,
};

describe("formula evaluator: arithmetic and operators", () => {
  it("evaluates arithmetic with precedence", () => {
    expect(evaluateFormula("price * qty + 1", row)).toBe(31);
    expect(evaluateFormula("price * (qty + 1)", row)).toBe(40);
    expect(evaluateFormula("10 % 3", {})).toBe(1);
    expect(evaluateFormula("-price + +'2'", row)).toBe(-8);
    expect(evaluateFormula("2 * -3", {})).toBe(-6);
  });

  it("evaluates comparisons and equality", () => {
    expect(evaluateFormula("price > 5 && qty <= 3", row)).toBe(true);
    expect(evaluateFormula("status == 'open'", row)).toBe(true);
    expect(evaluateFormula("status === 'closed'", row)).toBe(false);
    expect(evaluateFormula("price != '10'", row)).toBe(false);
    expect(evaluateFormula("price !== '10'", row)).toBe(true);
  });

  it("concatenates strings with +", () => {
    expect(evaluateFormula("'total: ' + price * qty", row)).toBe("total: 30");
  });

  it("supports literals", () => {
    expect(evaluateFormula("true", {})).toBe(true);
    expect(evaluateFormula("null", {})).toBeNull();
    expect(evaluateFormula("undefined", {})).toBeUndefined();
    expect(evaluateFormula("Number.isNaN(NaN)", {})).toBe(true);
    expect(evaluateFormula("Infinity > 1", {})).toBe(true);
    expect(evaluateFormula("'a\\nb'", {})).toBe("a\nb");
    expect(evaluateFormula(".5 + 1", {})).toBe(1.5);
  });

  it("decodes string escapes with JavaScript semantics", () => {
    expect(evaluateFormula(String.raw`'He said \"hi\"'`, {})).toBe('He said "hi"');
    expect(evaluateFormula(String.raw`"It\'s"`, {})).toBe("It's");
    expect(evaluateFormula(String.raw`'line1\r\nline2'`, {})).toBe("line1\r\nline2");
    expect(evaluateFormula(String.raw`'\t\b\f\v\0'`, {})).toBe("\t\b\f\v\0");
    expect(evaluateFormula(String.raw`'a\\b'`, {})).toBe("a\\b");
    expect(evaluateFormula(String.raw`'100\% done'`, {})).toBe("100% done");
    expect(evaluateFormula(String.raw`'\/'`, {})).toBe("/");
    expect(evaluateFormula(String.raw`'\x41\u00e9'`, {})).toBe("A\u00e9");
    expect(evaluateFormula(String.raw`'\u{1F600}'`, {})).toBe("\u{1F600}");
    expect(evaluateFormula(String.raw`'\u{0000041}'`, {})).toBe("A");
    expect(evaluateFormula("'\u2014'", {})).toBe("\u2014");
  });

  it("rejects malformed hex and unicode escapes", () => {
    expect(() => evaluateFormula(String.raw`'\xZZ'`, {})).toThrow(FormulaError);
    expect(() => evaluateFormula(String.raw`'\x4'`, {})).toThrow(/Invalid hex escape/);
    expect(() => evaluateFormula(String.raw`'\u12'`, {})).toThrow(/Invalid hex escape/);
    expect(() => evaluateFormula(String.raw`'\u{}'`, {})).toThrow(/Invalid unicode escape/);
    expect(() => evaluateFormula(String.raw`'\u{110000}'`, {})).toThrow(/Invalid unicode escape/);
    expect(() => evaluateFormula(String.raw`'\u{00110000}'`, {})).toThrow(/Invalid unicode escape/);
    expect(() => evaluateFormula(String.raw`'\u{41'`, {})).toThrow(/Invalid unicode escape/);
    expect(() => evaluateFormula("'abc\\", {})).toThrow(/Unterminated string escape/);
  });

  it("evaluates nested ternaries", () => {
    expect(evaluateFormula("price > 5 ? 'big' : 'small'", row)).toBe("big");
    expect(evaluateFormula("price > 50 ? 'huge' : price > 5 ? 'big' : 'small'", row)).toBe("big");
  });
});

describe("formula evaluator: number literals", () => {
  it("accepts integers, decimals, a leading dot, and a trailing dot", () => {
    expect(evaluateFormula("1", {})).toBe(1);
    expect(evaluateFormula("1.5", {})).toBe(1.5);
    expect(evaluateFormula(".5", {})).toBe(0.5);
    expect(evaluateFormula("10.", {})).toBe(10);
    expect(evaluateFormula("0.1 + 0.2 > 0.3", {})).toBe(true);
  });

  it("allows member access after a decimal literal", () => {
    expect(evaluateFormula("1.5.toFixed(0)", {})).toBe("2");
    expect(evaluateFormula("255.0.toString(16)", {})).toBe("ff");
  });

  it("rejects literals with more than one decimal point instead of yielding NaN", () => {
    for (const expr of ["1.2.3", "1..2", "0.1.2 + 0", ".1.2"]) {
      expect(() => evaluateFormula(expr, {})).toThrow(FormulaError);
      expect(() => evaluateFormula(expr, {})).toThrow(/Malformed number literal/);
    }
  });

  it("rejects a lone dot, exponent notation, and hex literals, which are not supported", () => {
    expect(() => evaluateFormula(".", {})).toThrow(FormulaError);
    expect(() => evaluateFormula("1e3", {})).toThrow(FormulaError);
    expect(() => evaluateFormula("0xff", {})).toThrow(FormulaError);
  });

  it("rejects the exponentiation operator; Math.pow is the supported form", () => {
    expect(() => evaluateFormula("price ** 2", { price: 5 })).toThrow(FormulaError);
    expect(evaluateFormula("Math.pow(price, 2)", { price: 5 })).toBe(25);
  });
});

describe("formula evaluator: short-circuiting", () => {
  it("does not evaluate the untaken ternary branch", () => {
    expect(evaluateFormula("missing == null ? 0 : missing.value", row)).toBe(0);
    expect(evaluateFormula("owner != null ? owner.name : missing.value", row)).toBe("Ori");
  });

  it("short-circuits &&, ||, and ??", () => {
    expect(evaluateFormula("missing && missing.value", row)).toBeNull();
    expect(evaluateFormula("owner && owner.age", row)).toBe(40);
    expect(evaluateFormula("owner || missing.value", row)).toEqual(row.owner);
    expect(evaluateFormula("owner.name ?? missing.value", row)).toBe("Ori");
    expect(evaluateFormula("missing ?? 'fallback'", row)).toBe("fallback");
    expect(evaluateFormula("0 || 'x'", {})).toBe("x");
    expect(evaluateFormula("0 ?? 'x'", {})).toBe(0);
  });

  it("still evaluates the taken branch", () => {
    expect(() => evaluateFormula("missing == null ? missing.value : 0", row)).toThrow(
      /Cannot read property "value" of null/,
    );
  });
});

describe("formula evaluator: property access and methods", () => {
  it("reads row properties and nested objects", () => {
    expect(evaluateFormula("owner.name", row)).toBe("Ori");
    expect(evaluateFormula("owner['age']", row)).toBe(40);
    expect(evaluateFormula("owner.nope", row)).toBeUndefined();
  });

  it("calls safe string, array, and number methods", () => {
    expect(evaluateFormula("name.trim().toUpperCase()", row)).toBe("WIDGET");
    expect(evaluateFormula("status.length", row)).toBe(4);
    expect(evaluateFormula("status[0]", row)).toBe("o");
    expect(evaluateFormula("tags.join('-')", row)).toBe("a-b");
    expect(evaluateFormula("tags.length", row)).toBe(2);
    expect(evaluateFormula("tags[1]", row)).toBe("b");
    expect(evaluateFormula("[1, 2, 3].includes(qty)", row)).toBe(true);
    expect(evaluateFormula("(price / qty).toFixed(2)", row)).toBe("3.33");
  });

  it("treats canonical numeric index strings as array and string indices", () => {
    const indexed = { tags: ["a", "b", "c"], idx: "1", s: "abc" };
    expect(evaluateFormula('tags["1"]', indexed)).toBe("b");
    expect(evaluateFormula("tags[idx]", indexed)).toBe("b");
    expect(evaluateFormula('s["1"]', indexed)).toBe("b");
    expect(evaluateFormula('tags["length"]', indexed)).toBe(3);
    expect(() => evaluateFormula('tags["01"]', indexed)).toThrow();
    expect(() => evaluateFormula('tags["-1"]', indexed)).toThrow();
  });

  it("exposes Math, Number, and String builtins", () => {
    expect(evaluateFormula("Math.max(price, qty)", row)).toBe(10);
    expect(evaluateFormula("Math.round(Math.PI)", {})).toBe(3);
    expect(evaluateFormula("Number('42') + 1", {})).toBe(43);
    expect(evaluateFormula("Number.isFinite(price)", row)).toBe(true);
    expect(evaluateFormula("Number.isInteger(1.5)", {})).toBe(false);
    expect(evaluateFormula("Number.parseFloat('1.25')", {})).toBe(1.25);
    expect(evaluateFormula("Number.parseInt('12px')", {})).toBe(12);
    expect(evaluateFormula("String(price) + '!'", row)).toBe("10!");
    expect(evaluateFormula("price * Math.LOG2E", row)).toBe(10 * Math.LOG2E);
    expect(evaluateFormula("Math.SQRT1_2", {})).toBe(Math.SQRT1_2);
  });

  it("throws on unknown builtin namespace members instead of yielding undefined", () => {
    expect(() => evaluateFormula("Math.sin(1)", {})).toThrow(FormulaError);
    expect(() => evaluateFormula("Math.sin(1)", {})).toThrow(/not allowed/);
    expect(() => evaluateFormula("Math.nope", {})).toThrow(/not allowed/);
    expect(() => evaluateFormula("Math.toString", {})).toThrow(/not allowed/);
    expect(() => evaluateFormula("Number.MAX_SAFE_INTEGER", {})).toThrow(/not allowed/);
    expect(() => evaluateFormula("String.raw", {})).toThrow(/not allowed/);
  });

  it("rejects unsafe methods on primitives", () => {
    expect(() => evaluateFormula("tags.map(1)", row)).toThrow(/not allowed/);
    expect(() => evaluateFormula("status.valueOf()", row)).toThrow(/not allowed/);
    expect(() => evaluateFormula("Number.call", {})).toThrow(/not allowed/);
    expect(() => evaluateFormula("Math.random()", {})).toThrow(/not allowed/);
  });

  it("rejects inherited Object.prototype members on row objects", () => {
    expect(evaluateFormula("owner.toString", row)).toBeUndefined();
    expect(evaluateFormula("owner.hasOwnProperty", row)).toBeUndefined();
  });
});

describe("formula evaluator: sandbox escapes are blocked", () => {
  const escapes = [
    "status.constructor",
    "status['constructor']",
    'status["constru"+"ctor"]',
    "status[['constru', 'ctor'].join('')]",
    "owner.__proto__",
    "owner['__proto__']",
    "owner['__pro' + 'to__']",
    "Number.prototype",
    "String.constructor",
    "Math.constructor",
    "tags.constructor",
    "price.constructor",
    "constructor",
    "__proto__",
    "prototype",
    "owner.__defineGetter__",
    "owner.__lookupGetter__",
  ];

  for (const expr of escapes) {
    it(`blocks ${expr}`, () => {
      expect(() => evaluateFormula(expr, row)).toThrow(/not allowed/);
    });
  }

  it("blocks access to globals that are not in scope", () => {
    for (const name of ["process", "globalThis", "Bun", "require", "fetch", "eval", "Function"]) {
      expect(() => evaluateFormula(name, {})).toThrow(/Unknown variable/);
    }
  });

  it("rejects statements, assignments, and unsupported syntax", () => {
    expect(() => evaluateFormula("while(true){}", {})).toThrow(FormulaError);
    expect(() => evaluateFormula("price = 1", row)).toThrow(FormulaError);
    expect(() => evaluateFormula("`${price}`", row)).toThrow(/Template literals/);
    expect(() => evaluateFormula("() => 1", {})).toThrow(FormulaError);
    expect(() => evaluateFormula("new Date()", {})).toThrow(FormulaError);
    expect(() => evaluateFormula("price; qty", row)).toThrow(FormulaError);
    expect(() => evaluateFormula("{ a: 1 }", {})).toThrow(FormulaError);
    expect(() => evaluateFormula("'unterminated", {})).toThrow(/Unterminated/);
  });

  it("does not treat strings matching blocked names as code", () => {
    expect(evaluateFormula("'constructor'", {})).toBe("constructor");
    expect(evaluateFormula("'a' + 'constructor'", {})).toBe("aconstructor");
  });

  it("errors on calling non-functions", () => {
    expect(() => evaluateFormula("price()", row)).toThrow(/not callable/);
    expect(() => evaluateFormula("owner.name()", row)).toThrow(/not callable/);
  });

  it("enforces a nesting depth limit", () => {
    const deep = `${"(".repeat(500)}1${")".repeat(500)}`;
    expect(() => evaluateFormula(deep, {})).toThrow(/nesting too deep/);
    const ok = `${"(".repeat(50)}1${")".repeat(50)}`;
    expect(evaluateFormula(ok, {})).toBe(1);
  });

  it("enforces an operation limit on very long expressions", () => {
    const long = Array.from({ length: 6000 }, () => "1").join("+");
    expect(() => evaluateFormula(long, {})).toThrow(/operation limit/);
  });

  it("wraps failures in FormulaError with the expression", () => {
    let caught: unknown;
    try {
      evaluateFormula("missing.value", row);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormulaError);
    expect((caught as FormulaError).expression).toBe("missing.value");
    expect((caught as FormulaError).cause).toBeInstanceOf(Error);
  });
});
