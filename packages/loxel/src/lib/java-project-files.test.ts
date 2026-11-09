import { describe, expect, test } from "bun:test";

import { BUILTIN_FILE_ASSOCIATIONS } from "@/store/settings-store";

import { getFileIconPath } from "./file-icons";
import { resolveLanguage } from "./resolve-language";

function resolve(path: string, content?: string): string | null {
  return resolveLanguage(path, BUILTIN_FILE_ASSOCIATIONS, content);
}

describe("resolveLanguage for Java tooling files", () => {
  test.each([
    ["/repo/src/App.java", "java"],
    ["/repo/pom.xml", "xml"],
    ["/repo/lib-1.0.pom", "xml"],
    ["/repo/.classpath", "xml"],
    ["/repo/.project", "xml"],
    ["/repo/.factorypath", "xml"],
    ["/repo/src/view.fxml", "xml"],
    ["/repo/WEB-INF/tags.tld", "xml"],
  ])("%s → %s", (path, language) => {
    expect(resolve(path)).toBe(language);
  });

  test("resolves Eclipse project files without sniffing their content", () => {
    expect(resolve("/home/me/repo/.worktrees/fix/x/.factorypath", "no xml here")).toBe("xml");
  });

  test.each([
    ["/repo/META-INF/MANIFEST.MF"],
    ["/repo/src/main/webapp/index.jsp"],
    ["/repo/.java-version"],
    ["/repo/.sdkmanrc"],
  ])("leaves %s as plain text", (path) => {
    expect(resolve(path)).toBeNull();
  });
});

describe("Java project icons", () => {
  test.each([
    ["App.java", "java_dark.svg"],
    ["module-info.java", "module_dark.svg"],
    ["lib.jar", "archive_dark.svg"],
    ["app.war", "archive_dark.svg"],
    ["app.ear", "archive_dark.svg"],
    [".java-version", "java_dark.svg"],
    [".sdkmanrc", "java_dark.svg"],
  ])("%s → %s", (filename, icon) => {
    expect(getFileIconPath(filename)).toBe(`./icons/${icon}`);
  });
});
