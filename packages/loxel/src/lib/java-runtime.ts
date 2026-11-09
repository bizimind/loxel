import { getJavaEnvCandidates, setJavaOverride } from "@/api/java-env-client";
import { type JavaEnvSource, type JavaRuntime, javaToolchain } from "@/api/java-env-model";
import { showToast } from "@/components/ui/toast";
import { setToolchainStatusData } from "@/queries/use-toolchain-status";
import { type QuickPickItem, requestQuickPick, requestTextInput } from "@/store/command-palette";
import { useProjectStore } from "@/store/projects";

import { abbreviateHomePath } from "./home-path";

// Picker ids that cannot collide with a JDK path, which is always absolute.
const ENTER_PATH_ID = "#enter-path";
const AUTOMATIC_ID = "#automatic";

const SOURCE_DESCRIPTIONS: Record<JavaEnvSource, string> = {
  override: "Chosen for this worktree",
  "java-home": "Detected from JAVA_HOME",
  "java-home-tool": "Detected by the macOS java_home tool",
  path: "Detected from java on the login-shell PATH",
  "install-location": "Detected in a JDK install location",
};

/** The names distributions go by, where the `release` file's `IMPLEMENTOR` is its company's. */
const DISTRIBUTION_NAMES: Record<string, string> = {
  "Eclipse Adoptium": "Temurin",
  "Amazon.com Inc.": "Corretto",
  "Azul Systems, Inc.": "Zulu",
  BellSoft: "Liberica",
  "Oracle Corporation": "Oracle",
  "JetBrains s.r.o.": "JetBrains",
};

/** The JDK as shown in the status bar and picker, e.g. `Java 21.0.5 (Temurin)`. */
export function javaRuntimeLabel(runtime: JavaRuntime): string {
  const { implementor, version } = runtime;
  if (!implementor) return `Java ${version}`;
  return `Java ${version} (${DISTRIBUTION_NAMES[implementor] ?? implementor})`;
}

/** Where the JDK came from, for tooltips. */
export function javaEnvSourceDescription(source: JavaEnvSource): string {
  return SOURCE_DESCRIPTIONS[source];
}

/**
 * Let the user choose worktree `wtPath`'s JDK in the command palette: a discovered one, a path they
 * enter, or automatic detection. The choice is saved per worktree on the server, which hands it to
 * everything that resolves the worktree's JDK.
 */
export async function selectJavaRuntime(wtPath: string): Promise<void> {
  const { homeDir } = useProjectStore.getState();
  const state = getJavaEnvCandidates(wtPath);
  const items = state.then(({ candidates, automatic, overridePath }) => {
    const list: QuickPickItem[] = [
      { id: ENTER_PATH_ID, label: "Enter JDK path…" },
      {
        id: AUTOMATIC_ID,
        label: "Use automatic detection",
        description: automatic ? javaRuntimeLabel(automatic) : "No JDK found",
        current: overridePath === null,
      },
      ...candidates.map((c) => ({
        id: c.path,
        label: javaRuntimeLabel(c),
        description: abbreviateHomePath(c.path, homeDir),
        current: c.path === overridePath,
      })),
    ];
    return list;
  });

  const picked = await requestQuickPick({ placeholder: "Select a JDK", items });
  if (picked === null) return;

  let javaHome: string | null = picked === AUTOMATIC_ID ? null : picked;
  if (picked === ENTER_PATH_ID) {
    const { overridePath } = await state;
    javaHome = await requestTextInput({
      placeholder: "Path to a JDK's home directory",
      value: overridePath ?? "",
    });
    if (javaHome === null) return;
  }

  try {
    const response = await setJavaOverride({ worktreePath: wtPath, javaHome });
    setToolchainStatusData(javaToolchain, wtPath, response);
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Could not set the JDK");
  }
}
