import { test, expect, describe } from "bun:test";

import { parseCommand } from "./command-parser.ts";

describe("parseCommand", () => {
  describe("simple commands", () => {
    test("single command without operators", () => {
      const result = parseCommand("ls -la");
      expect(result.isSimple).toBe(true);
      expect(result.commands).toEqual(["ls -la"]);
    });

    test("git status", () => {
      const result = parseCommand("git status");
      expect(result.isSimple).toBe(true);
      expect(result.commands).toEqual(["git status"]);
    });
  });

  describe("chained commands", () => {
    test("&& chaining", () => {
      const result = parseCommand("npm install && npm test");
      expect(result.isSimple).toBe(true);
      expect(result.commands).toEqual(["npm install", "npm test"]);
    });

    test("|| chaining", () => {
      const result = parseCommand("cat file || echo 'not found'");
      expect(result.isSimple).toBe(true);
      expect(result.commands).toEqual(["cat file", "echo 'not found'"]);
    });

    test("; chaining", () => {
      const result = parseCommand("echo hello; echo world");
      expect(result.isSimple).toBe(true);
      expect(result.commands).toEqual(["echo hello", "echo world"]);
    });

    test("pipe chaining", () => {
      const result = parseCommand("cat file | grep pattern");
      expect(result.isSimple).toBe(true);
      expect(result.commands).toEqual(["cat file", "grep pattern"]);
    });

    test("multiple operators", () => {
      const result = parseCommand("npm install && npm build && npm test");
      expect(result.isSimple).toBe(true);
      expect(result.commands).toEqual(["npm install", "npm build", "npm test"]);
    });
  });

  describe("complex commands - should delegate to Haiku", () => {
    test("command substitution $()", () => {
      const result = parseCommand("echo $(pwd)");
      expect(result.isSimple).toBe(false);
      expect(result.commands).toBeNull();
    });

    test("backtick substitution", () => {
      const result = parseCommand("echo `pwd`");
      expect(result.isSimple).toBe(false);
      expect(result.commands).toBeNull();
    });

    test("eval command", () => {
      const result = parseCommand('eval "echo hello"');
      expect(result.isSimple).toBe(false);
      expect(result.commands).toBeNull();
    });

    test("xargs command", () => {
      const result = parseCommand("find . | xargs rm");
      expect(result.isSimple).toBe(false);
      expect(result.commands).toBeNull();
    });

    test("here document", () => {
      const result = parseCommand("cat << EOF");
      expect(result.isSimple).toBe(false);
      expect(result.commands).toBeNull();
    });

    test("variable expansion ${}", () => {
      const result = parseCommand("echo ${HOME}");
      expect(result.isSimple).toBe(false);
      expect(result.commands).toBeNull();
    });

    test("source command", () => {
      const result = parseCommand("source ~/.bashrc");
      expect(result.isSimple).toBe(false);
      expect(result.commands).toBeNull();
    });
  });

  describe("quoted strings", () => {
    test("operators inside double quotes are not split", () => {
      const result = parseCommand('echo "hello && world"');
      expect(result.isSimple).toBe(true);
      expect(result.commands).toEqual(['echo "hello && world"']);
    });

    test("operators inside single quotes are not split", () => {
      const result = parseCommand("echo 'hello && world'");
      expect(result.isSimple).toBe(true);
      expect(result.commands).toEqual(["echo 'hello && world'"]);
    });

    test("mixed quotes and operators", () => {
      const result = parseCommand('echo "hello" && echo "world"');
      expect(result.isSimple).toBe(true);
      expect(result.commands).toEqual(['echo "hello"', 'echo "world"']);
    });
  });

  describe("redirects", () => {
    test("output redirect is part of command", () => {
      const result = parseCommand("echo hello > file.txt");
      expect(result.isSimple).toBe(true);
      expect(result.commands).toEqual(["echo hello > file.txt"]);
    });

    test("append redirect", () => {
      const result = parseCommand("echo hello >> file.txt");
      expect(result.isSimple).toBe(true);
      expect(result.commands).toEqual(["echo hello >> file.txt"]);
    });
  });

  describe("background operator", () => {
    test("& background is complex", () => {
      const result = parseCommand("sleep 10 &");
      expect(result.isSimple).toBe(false);
    });
  });
});
