import type { ToolchainStatusDescriptor } from "./toolchain-status-model";

/** Where a worktree's JDK was found, listed in resolution order. */
export type JavaEnvSource =
  | "override"
  | "java-home"
  | "java-home-tool"
  | "path"
  | "install-location";

/** A JDK on this machine, as its `release` file describes it. Nothing is executed to learn this. */
export interface JavaRuntime {
  /** Absolute path of the JDK's home directory, the one holding `bin/java` and `release`. */
  path: string;
  /** The Java level, e.g. 21 for `21.0.5` and 8 for `1.8.0_392`. */
  majorVersion: number;
  /** `JAVA_VERSION` from the `release` file, e.g. `21.0.5`. */
  version: string;
  /** `IMPLEMENTOR` from the `release` file, e.g. `Eclipse Adoptium`; null when it has none. */
  implementor: string | null;
}

/** A {@link JavaRuntime} and how it was found. */
export interface JavaEnv extends JavaRuntime {
  source: JavaEnvSource;
}

/** `GET /api/java-env?wt=` response; `env` is null when no JDK was found. */
export interface JavaEnvResponse {
  env: JavaEnv | null;
  /** JDK home chosen for the worktree, even when it is not usable and detection took over. */
  overridePath: string | null;
  /** The value of `JAVA_HOME` when it is set but is not a usable JDK. */
  ignoredJavaHome: string | null;
}

/** `GET /api/java-env/candidates?wt=` response: JDKs the user can pick for a worktree. */
export interface JavaEnvCandidatesResponse {
  /** Newest first. */
  candidates: JavaEnv[];
  /** What automatic detection would choose. */
  automatic: JavaEnv | null;
  /** As in {@link JavaEnvResponse}; a usable override is one of the candidates. */
  overridePath: string | null;
}

/** `POST /api/java-env/override` body; a null `javaHome` returns the worktree to automatic detection. */
export interface JavaOverrideRequest {
  worktreePath: string;
  javaHome: string | null;
}

/** `POST /api/java-env/build-file` body: a file of the worktree. */
export interface JavaBuildFileRequest {
  worktreePath: string;
  filePath: string;
}

/** `POST /api/java-env/build-file` response: the build tool of the file's nearest build file. */
export interface JavaBuildFileResponse {
  /** Null when no folder from the file up to the worktree holds a build file. */
  buildTool: "Maven" | "Gradle" | null;
}

export const javaToolchain = {
  id: "java",
  languageIds: ["java"],
  changedMessage: "java_env_changed",
  selectAction: { id: "java.selectRuntime", label: "Java: Select JDK" },
} as const satisfies ToolchainStatusDescriptor;
