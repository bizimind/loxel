import type { ThemedToken, ThemedTokenScopeExplanation } from "shiki";

import { getHighlighter } from "./highlighter";
import { toMonacoLanguage } from "./monaco-theme";

export interface SemanticOverride {
  foregroundColor: string;
}

export interface ScopeInspectorData {
  tokenContent: string;
  foregroundColor: string | undefined;
  scopes: ThemedTokenScopeExplanation[];
  shikiLang: string;
  monacoLang: string | undefined;
  semanticOverride: SemanticOverride | null;
}

export async function inspectTokenAtPosition(
  lineText: string,
  cursorColumn: number,
  shikiLang: string,
  themeName: string,
): Promise<ScopeInspectorData | null> {
  const highlighter = await getHighlighter();

  if (!highlighter.getLoadedLanguages().includes(shikiLang)) return null;

  const tokens = highlighter.codeToTokensBase(lineText, {
    lang: shikiLang as Parameters<typeof highlighter.codeToTokensBase>[1]["lang"],
    theme: themeName as Parameters<typeof highlighter.codeToTokensBase>[1]["theme"],
    includeExplanation: true,
  });

  const lineTokens = tokens[0];
  if (!lineTokens) return null;

  const cursorOffset = cursorColumn - 1;
  const token = findTokenAtOffset(lineTokens, cursorOffset);
  if (!token?.explanation?.length) return null;

  const lastExplanation = token.explanation.at(-1)!;
  const monacoLang = toMonacoLanguage(shikiLang);

  return {
    tokenContent: token.content,
    foregroundColor: token.color,
    scopes: lastExplanation.scopes,
    shikiLang,
    monacoLang: monacoLang !== shikiLang ? monacoLang : undefined,
    semanticOverride: null,
  };
}

function findTokenAtOffset(tokens: ThemedToken[], offset: number): ThemedToken | null {
  for (const token of tokens) {
    if (offset >= token.offset && offset < token.offset + token.content.length) {
      return token;
    }
  }
  return tokens.at(-1) ?? null;
}
