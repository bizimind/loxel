import type { editor as monacoEditor } from "monaco-editor";
import * as monaco from "monaco-editor";

import type { ScopeInspectorData } from "@/lib/textmate-inspector";

export class TextMateScopeInspector implements monacoEditor.IContentWidget {
  allowEditorOverflow = true;
  suppressMouseDown = false;

  private domNode: HTMLElement;
  private contentNode: HTMLElement;
  private onClose: () => void;
  private position: monacoEditor.IContentWidgetPosition | null = null;

  constructor(onClose: () => void) {
    this.onClose = onClose;
    this.domNode = document.createElement("div");
    Object.assign(this.domNode.style, {
      padding: "12px",
      minWidth: "300px",
      maxWidth: "420px",
      maxHeight: "320px",
      overflowY: "auto",
      borderRadius: "6px",
      border: "1px solid var(--border)",
      background: "oklch(from var(--popover) l c h / 0.95)",
      backdropFilter: "blur(4px)",
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
      fontSize: "12px",
      lineHeight: "1.5",
      color: "var(--foreground)",
      pointerEvents: "auto",
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "8px",
      fontWeight: "600",
      fontSize: "11px",
      textTransform: "uppercase",
      letterSpacing: "0.05em",
      opacity: "0.6",
    });
    header.textContent = "TextMate Scopes";

    const closeBtn = document.createElement("button");
    Object.assign(closeBtn.style, {
      background: "none",
      border: "none",
      color: "var(--foreground)",
      cursor: "pointer",
      padding: "2px",
      fontSize: "14px",
      lineHeight: "1",
      opacity: "0.6",
    });
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", this.onClose);
    closeBtn.addEventListener("mouseenter", () => (closeBtn.style.opacity = "1"));
    closeBtn.addEventListener("mouseleave", () => (closeBtn.style.opacity = "0.6"));
    header.appendChild(closeBtn);

    this.contentNode = document.createElement("div");

    this.domNode.appendChild(header);
    this.domNode.appendChild(this.contentNode);
  }

  getId(): string {
    return "textmate-scope-inspector";
  }

  getDomNode(): HTMLElement {
    return this.domNode;
  }

  getPosition(): monacoEditor.IContentWidgetPosition | null {
    return this.position;
  }

  setEditorPosition(pos: monaco.IPosition): void {
    this.position = {
      position: pos,
      preference: [
        monaco.editor.ContentWidgetPositionPreference.BELOW,
        monaco.editor.ContentWidgetPositionPreference.ABOVE,
      ],
    };
  }

  update(data: ScopeInspectorData | null, unavailableMessage?: string): void {
    this.contentNode.innerHTML = "";

    if (unavailableMessage) {
      const msg = document.createElement("div");
      msg.style.opacity = "0.5";
      msg.textContent = unavailableMessage;
      this.contentNode.appendChild(msg);
      return;
    }

    if (!data) {
      const msg = document.createElement("div");
      msg.style.opacity = "0.5";
      msg.textContent = "Move cursor to a token";
      this.contentNode.appendChild(msg);
      return;
    }

    // Token content with its color
    const tokenRow = document.createElement("div");
    tokenRow.style.marginBottom = "8px";

    const tokenLabel = createLabel("token");
    tokenRow.appendChild(tokenLabel);

    const tokenValue = document.createElement("span");
    tokenValue.textContent = data.tokenContent;
    if (data.foregroundColor) tokenValue.style.color = data.foregroundColor;
    tokenValue.style.fontWeight = "500";
    tokenRow.appendChild(tokenValue);

    if (data.foregroundColor) {
      const colorSwatch = createSwatch(data.foregroundColor);
      colorSwatch.style.marginLeft = "6px";
      tokenRow.appendChild(colorSwatch);

      const colorHex = document.createElement("span");
      colorHex.textContent = data.foregroundColor;
      colorHex.style.opacity = "0.5";
      colorHex.style.marginLeft = "4px";
      tokenRow.appendChild(colorHex);
    }

    this.contentNode.appendChild(tokenRow);

    // Scope stack
    const scopeSection = document.createElement("div");
    scopeSection.style.marginBottom = "8px";
    scopeSection.appendChild(createLabel("scopes"));

    for (let i = 0; i < data.scopes.length; i++) {
      const scope = data.scopes[i]!;
      const scopeLine = document.createElement("div");
      scopeLine.style.paddingLeft = `${i * 8}px`;

      const isLast = i === data.scopes.length - 1;
      if (isLast) scopeLine.style.fontWeight = "600";

      scopeLine.textContent = scope.scopeName;
      scopeSection.appendChild(scopeLine);
    }

    this.contentNode.appendChild(scopeSection);

    // Theme matches (from the most specific scope that has matches)
    const matchedScope = [...data.scopes].reverse().find((s) => s.themeMatches?.length);
    if (matchedScope?.themeMatches) {
      const matchSection = document.createElement("div");
      matchSection.style.marginBottom = "8px";
      matchSection.appendChild(createLabel("theme rule"));

      for (const match of matchedScope.themeMatches) {
        const matchLine = document.createElement("div");
        matchLine.style.display = "flex";
        matchLine.style.alignItems = "center";
        matchLine.style.gap = "6px";

        const scopeText = document.createElement("span");
        const scopeValue = Array.isArray(match.scope)
          ? match.scope.join(", ")
          : (match.scope ?? "(default)");
        scopeText.textContent = scopeValue;
        matchLine.appendChild(scopeText);

        if (match.settings.foreground) {
          matchLine.appendChild(createSwatch(match.settings.foreground));
        }

        matchSection.appendChild(matchLine);
      }

      this.contentNode.appendChild(matchSection);
    }

    // Semantic override
    if (data.semanticOverride) {
      const semSection = document.createElement("div");
      semSection.style.marginBottom = "8px";
      semSection.appendChild(createLabel("semantic override"));

      const overrideRow = document.createElement("div");
      overrideRow.style.display = "flex";
      overrideRow.style.alignItems = "center";
      overrideRow.style.gap = "6px";

      const overrideText = document.createElement("span");
      overrideText.textContent = data.tokenContent;
      overrideText.style.color = data.semanticOverride.foregroundColor;
      overrideText.style.fontWeight = "500";
      overrideRow.appendChild(overrideText);

      overrideRow.appendChild(createSwatch(data.semanticOverride.foregroundColor));

      const overrideHex = document.createElement("span");
      overrideHex.textContent = data.semanticOverride.foregroundColor;
      overrideHex.style.opacity = "0.5";
      overrideRow.appendChild(overrideHex);

      const arrow = document.createElement("span");
      arrow.textContent = "(overrides TextMate)";
      arrow.style.opacity = "0.4";
      arrow.style.fontSize = "10px";
      overrideRow.appendChild(arrow);

      semSection.appendChild(overrideRow);
      this.contentNode.appendChild(semSection);
    }

    // Language
    const langRow = document.createElement("div");
    langRow.appendChild(createLabel("language"));
    const langValue = document.createElement("span");
    langValue.textContent = data.monacoLang
      ? `${data.shikiLang} → ${data.monacoLang}`
      : data.shikiLang;
    langRow.appendChild(langValue);
    this.contentNode.appendChild(langRow);
  }

  dispose(): void {
    this.domNode.remove();
  }
}

function createLabel(text: string): HTMLElement {
  const label = document.createElement("span");
  Object.assign(label.style, {
    fontSize: "10px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    opacity: "0.4",
    marginRight: "6px",
  });
  label.textContent = text;
  return label;
}

function createSwatch(color: string): HTMLElement {
  const swatch = document.createElement("span");
  Object.assign(swatch.style, {
    display: "inline-block",
    width: "10px",
    height: "10px",
    borderRadius: "2px",
    backgroundColor: color,
    border: "1px solid rgba(128,128,128,0.3)",
    verticalAlign: "middle",
  });
  return swatch;
}
