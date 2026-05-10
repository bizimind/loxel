import type { Element, ElementContent, Root } from "hast";
import type { Plugin } from "unified";

import { visit } from "unist-util-visit";

// ── Detection ──────────────────────────────────────────────────────────────

const MODIFIERS = new Set(["Cmd", "Ctrl", "Alt", "Shift"]);

const STANDALONE = new Set([
  "Tab",
  "Enter",
  "Esc",
  "Escape",
  "Space",
  "Backspace",
  "Delete",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
  "←",
  "→",
  "↑",
  "↓",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

const PUNCTUATION = new Set(["\\", ",", ".", "/", "[", "]", "`"]);

function isToken(t: string): boolean {
  return (
    MODIFIERS.has(t) ||
    STANDALONE.has(t) ||
    /^F([1-9]|1[0-2])$/.test(t) ||
    /^[A-Z]$/.test(t) ||
    /^[0-9]$/.test(t) ||
    PUNCTUATION.has(t)
  );
}

export function isShortcut(text: string): boolean {
  if (!text.includes("+")) return STANDALONE.has(text) || /^F([1-9]|1[0-2])$/.test(text);
  const tokens = text.split("+");
  return tokens.every(isToken) && tokens.some((t) => MODIFIERS.has(t));
}

// ── Display ────────────────────────────────────────────────────────────────

const ARIA_LABELS: Record<string, string> = {
  Cmd: "Command",
  Ctrl: "Control",
  Alt: "Option",
  Shift: "Shift",
  Tab: "Tab",
  Enter: "Return",
  Esc: "Escape",
  Escape: "Escape",
  Space: "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up Arrow",
  ArrowDown: "Down Arrow",
  ArrowLeft: "Left Arrow",
  ArrowRight: "Right Arrow",
  "↑": "Up Arrow",
  "↓": "Down Arrow",
  "←": "Left Arrow",
  "→": "Right Arrow",
};

const KEY_LABELS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
};

// Lucide icon paths (same icons as the app's KeyComboDisplay)
const ICON_PATHS: Record<string, string[]> = {
  Cmd: ["M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"],
  Ctrl: ["m18 15-6-6-6 6"],
  Alt: ["M3 3h6l6 18h6", "M14 3h7"],
  Shift: ["M9 18v-6H5l7-7 7 7h-4v6H9z"],
};

function makeSvg(paths: string[]): Element {
  return {
    type: "element",
    tagName: "svg",
    properties: {
      xmlns: "http://www.w3.org/2000/svg",
      width: "1em",
      height: "1em",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      ariaHidden: "true",
    },
    children: paths.map((d) => ({
      type: "element" as const,
      tagName: "path",
      properties: { d },
      children: [],
    })),
  };
}

function makeKeyNode(token: string): Element {
  const paths = ICON_PATHS[token];
  const children: ElementContent[] = paths
    ? [makeSvg(paths)]
    : [{ type: "text", value: KEY_LABELS[token] ?? token }];

  return {
    type: "element",
    tagName: "kbd",
    properties: { className: ["kbd-key"], ariaHidden: "true" },
    children,
  };
}

function buildKbdNode(text: string): Element {
  const tokens = text.includes("+") ? text.split("+") : [text];
  const ariaLabel = tokens.map((t) => ARIA_LABELS[t] ?? t).join("+");

  return {
    type: "element",
    tagName: "kbd",
    properties: { className: ["kbd-combo"], ariaLabel },
    children: tokens.map(makeKeyNode),
  };
}

// ── Plugin ─────────────────────────────────────────────────────────────────

export const rehypeKbd: Plugin<[], Root> = () => (tree) => {
  visit(tree, "element", (node: Element, index, parent) => {
    if (node.tagName !== "code") return;
    if (!parent || (parent as Element).tagName === "pre") return;
    if (index === null || index === undefined) return;

    const child = node.children[0];
    if (!child || child.type !== "text") return;
    if (!isShortcut(child.value)) return;

    (parent as Element).children[index] = buildKbdNode(child.value);
  });
};
