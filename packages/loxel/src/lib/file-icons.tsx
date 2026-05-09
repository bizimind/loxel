/**
 * JetBrains-style file and folder icon mappings.
 * Derived from vscode-jetbrains-icon-theme (theme-dark.json).
 */

/** Exact filename to SVG icon filename */
const FILE_NAME_MAP: Record<string, string> = {
  dune: "dune.svg",
  "dune-project": "dune.svg",
  ".gitignore": "gitignore.svg",
  ".gitattributes": "gitignore.svg",
  ".gitmodules": "gitignore.svg",
  ".gitkeep": "gitignore.svg",
  ".git-blame-ignore-revs": "gitignore.svg",
  ".editorconfig": "editorConfig_dark.svg",
  ".yarnrc": "yarn.svg",
  "yarn.lock": "yarn.svg",
  ".bunrc": "bun.svg",
  "bun.lock": "bun.svg",
  "bunfig.toml": "bun.svg",
  README: "markdown_dark.svg",
  ".dockerignore": "ignored_dark.svg",
  Dockerfile: "docker_dark.svg",
  "Dockerfile.dev": "docker_dark.svg",
  "Dockerfile.test": "docker_dark.svg",
  "Dockerfile.staging": "docker_dark.svg",
  "Dockerfile.prod": "docker_dark.svg",
  "Dockerfile.production": "docker_dark.svg",
  Gemfile: "rubyGems_dark.svg",
  "Gemfile.lock": "rubyGems_dark.svg",
  Makefile: "makefile_dark.svg",
  ".env": "anyType_dark.svg",
  ".env.local": "anyType_dark.svg",
  ".env.test": "anyType_dark.svg",
  ".env.example": "anyType_dark.svg",
  ".env.development": "anyType_dark.svg",
  ".env.production": "anyType_dark.svg",
  ".env.test.local": "anyType_dark.svg",
  ".env.development.local": "anyType_dark.svg",
  ".env.production.local": "anyType_dark.svg",
  "Cargo.toml": "cargo_dark.svg",
  "rust-toolchain.toml": "cargo_dark.svg",
  "Cargo.lock": "cargoLock_dark.svg",
  "CMakeLists.txt": "CMake_dark.svg",
  "CMakeCache.txt": "config_dark.svg",
  "pnpm.lock": "pnpm_dark.svg",
  "pnpm-lock.yaml": "pnpm_dark.svg",
  "pnpm-workspace.yaml": "pnpm_dark.svg",
  "tailwind.config.js": "tailwind.svg",
  "tailwind.config.cjs": "tailwind.svg",
  "tailwind.config.ts": "tailwind.svg",
  "vite.config.js": "vite_dark.svg",
  "vite.config.cjs": "vite_dark.svg",
  "vite.config.ts": "vite_dark.svg",
  "postcss.config.js": "postcss.svg",
  "postcss.config.cjs": "postcss.svg",
  "postcss.config.ts": "postcss.svg",
  "angular.json": "angularJS.svg",
  "biome.json": "biomejs.svg",
  ".eslintrc": "eslint.svg",
  ".eslintrc.cjs": "eslint.svg",
  ".eslintrc.js": "eslint.svg",
  ".eslintrc.ts": "eslint.svg",
  ".eslintrc.json": "eslint.svg",
  ".eslintrc.yml": "eslint.svg",
  ".eslintrc.yaml": "eslint.svg",
  ".eslintignore": "eslint.svg",
  ".prettierrc": "prettier_dark.svg",
  ".prettierrc.js": "prettier_dark.svg",
  ".prettierrc.ts": "prettier_dark.svg",
  ".prettierrc.cjs": "prettier_dark.svg",
  ".prettierrc.cts": "prettier_dark.svg",
  ".prettierrc.json": "prettier_dark.svg",
  ".prettierrc.json5": "prettier_dark.svg",
  ".prettierrc.mjs": "prettier_dark.svg",
  ".prettierrc.mts": "prettier_dark.svg",
  ".prettierrc.toml": "prettier_dark.svg",
  ".prettierrc.yaml": "prettier_dark.svg",
  ".prettierrc.yml": "prettier_dark.svg",
  "prettier.config.js": "prettier_dark.svg",
  "prettier.config.ts": "prettier_dark.svg",
  "prettier.config.cjs": "prettier_dark.svg",
  "prettier.config.cts": "prettier_dark.svg",
  "prettier.config.mjs": "prettier_dark.svg",
  "prettier.config.mts": "prettier_dark.svg",
  ".prettierignore": "prettier_dark.svg",
  ".nvmrc": "nodejs_dark.svg",
  ".node-version": "nodejs_dark.svg",
  ".npmrc": "npm_dark.svg",
  "go.mod": "goMod_dark.svg",
  "go.sum": "goSum_dark.svg",
  "go.work": "goWork_dark.svg",
  "Directory.Build.props": "projectProperties_dark.svg",
  "vercel.json": "vercel.svg",
};

/** Compound extensions (checked before simple ext) */
const COMPOUND_EXT_MAP: Record<string, string> = {
  "test.ts": "tsTest_dark.svg",
  "test.tsx": "tsxTest_dark.svg",
  "spec.ts": "tsTest_dark.svg",
  "spec.tsx": "tsxTest_dark.svg",
  "test.js": "jsTest_dark.svg",
  "test.jsx": "jsxTest_dark.svg",
  "spec.js": "jsTest_dark.svg",
  "spec.jsx": "jsxTest_dark.svg",
};

/** Simple file extension to SVG icon filename */
const EXT_MAP: Record<string, string> = {
  handlebars: "handlebarsJson_dark.svg",
  hbs: "handlebarsJson_dark.svg",
  ml: "ml.svg",
  mli: "mli.svg",
  opam: "opam.svg",
  css: "css.svg",
  dart: "dart_dark.svg",
  erb: "erbFile_dark.svg",
  scss: "scss.svg",
  sass: "scss.svg",
  kt: "kotlin_dark.svg",
  kts: "kotlinScript_dark.svg",
  json: "json_dark.svg",
  jsonc: "json_dark.svg",
  json5: "json_dark.svg",
  html: "html_dark.svg",
  jsx: "jsx_dark.svg",
  tsx: "tsx_dark.svg",
  rake: "rakeTask_dark.svg",
  rb: "ruby_dark.svg",
  less: "less_dark.svg",
  js: "javaScript_dark.svg",
  cjs: "javaScript_dark.svg",
  mjs: "javaScript_dark.svg",
  ts: "typeScript_dark.svg",
  cts: "typeScript_dark.svg",
  mts: "typeScript_dark.svg",
  csv: "csv_dark.svg",
  vue: "vueJs.svg",
  png: "image_dark.svg",
  webp: "image_dark.svg",
  jpg: "image_dark.svg",
  jpeg: "image_dark.svg",
  gif: "image_dark.svg",
  gleam: "gleam_dark.svg",
  ico: "image_dark.svg",
  svg: "image_dark.svg",
  ttf: "font_dark.svg",
  woff: "font_dark.svg",
  otf: "font_dark.svg",
  eot: "font_dark.svg",
  yaml: "yaml_dark.svg",
  yml: "yaml_dark.svg",
  java: "java_dark.svg",
  xml: "xml_dark.svg",
  sql: "sql_dark.svg",
  md: "markdown_dark.svg",
  properties: "properties_dark.svg",
  sh: "shell_dark.svg",
  zsh: "shell_dark.svg",
  bash: "shell_dark.svg",
  bat: "shell_dark.svg",
  ps1: "shell_dark.svg",
  h: "h_dark.svg",
  hh: "h_dark.svg",
  hpp: "h_dark.svg",
  hxx: "h_dark.svg",
  c: "c_dark.svg",
  cc: "cpp_dark.svg",
  cpp: "cpp_dark.svg",
  cxx: "cpp_dark.svg",
  ccm: "cpp_dark.svg",
  cxxm: "cpp_dark.svg",
  cppm: "cpp_dark.svg",
  "c++m": "cpp_dark.svg",
  ixx: "cpp_dark.svg",
  cu: "cu_dark.svg",
  cuh: "cuh_dark.svg",
  scala: "scala_dark.svg",
  gz: "archive_dark.svg",
  zip: "archive_dark.svg",
  rar: "archive_dark.svg",
  "7z": "archive_dark.svg",
  tar: "archive_dark.svg",
  toml: "toml_dark.svg",
  py: "python.svg",
  pyi: "python.svg",
  pyc: "python.svg",
  tf: "terraform_dark.svg",
  go: "go_dark.svg",
  http: "http_dark.svg",
  rest: "http_dark.svg",
  as: "actionScript_dark.svg",
  php: "php_dark.svg",
  cfg: "config_dark.svg",
  conf: "config_dark.svg",
  config: "config_dark.svg",
  cnf: "config_dark.svg",
  svelte: "svelte.svg",
  slim: "slim_dark.svg",
  sln: "solution_dark.svg",
  rs: "rustFile_dark.svg",
  cs: "cs_dark.svg",
  cshtml: "cshtml_dark.svg",
  csproj: "csproj_dark.svg",
  ex: "elixir_dark.svg",
  exs: "elixir_dark.svg",
  eex: "eex_dark.svg",
  heex: "eex_dark.svg",
  leex: "eex_dark.svg",
  beam: "beam.svg",
  dockerfile: "docker_dark.svg",
  swift: "swift.svg",
  cljc: "clojure.svg",
  cljs: "clojure.svg",
  clj: "clojure.svg",
  edn: "clojure.svg",
  proto: "protoFile_dark.svg",
  hcl: "hcl_dark.svg",
  rego: "rego.svg",
  exe: "application_dark.svg",
  ipynb: "jupyter.svg",
  mdx: "mdx.svg",
  erl: "erlang.svg",
  lua: "lua.svg",
  hs: "haskell.svg",
  graphql: "graphql.svg",
  gql: "graphql.svg",
  db: "dbms_dark.svg",
  sqlite: "dbms_dark.svg",
  sqlite3: "dbms_dark.svg",
  db3: "dbms_dark.svg",
  accdb: "dbms_dark.svg",
  mdb: "dbms_dark.svg",
  dbf: "dbms_dark.svg",
  ndf: "dbms_dark.svg",
  ibd: "dbms_dark.svg",
  frm: "dbms_dark.svg",
  ora: "dbms_dark.svg",
  lock: "lock_dark.svg",
  ino: "ino_dark.svg",
  jinja: "html_dark.svg",
  razor: "cshtml_dark.svg",
  cmake: "CMake_dark.svg",
  tofu: "opentofu.svg",
  zig: "zig.svg",
  c3: "c3_dark.svg",
  c3t: "c3Test_dark.svg",
  c3i: "c3Interface_dark.svg",
  c3l: "c3Library_dark.svg",
  v: "vlang_dark.svg",
  vsh: "vlang_dark.svg",
};

/** Folder name to SVG icon filename */
const FOLDER_NAME_MAP: Record<string, string> = {
  ".github": "folderGithub_dark.svg",
  vendor: "folderVendor_dark.svg",
  controllers: "folderControllers_dark.svg",
  mailers: "folderMailers_dark.svg",
  helpers: "folderHelpers_dark.svg",
  migrate: "folderMigrations_dark.svg",
  test: "folderTest_dark.svg",
  tests: "folderTest_dark.svg",
  spec: "folderTest_dark.svg",
  specs: "folderTest_dark.svg",
  __test__: "folderTest_dark.svg",
  __tests__: "folderTest_dark.svg",
  __fixtures__: "folderTest_dark.svg",
  __snapshots__: "folderTest_dark.svg",
};

const DEFAULT_FILE_ICON = "text_dark.svg";
const DEFAULT_FOLDER_ICON = "folder_dark.svg";

/** Compound extensions sorted by dot-count descending for greedy matching */
const COMPOUND_KEYS = Object.keys(COMPOUND_EXT_MAP).sort(
  (a, b) => b.split(".").length - a.split(".").length,
);

export function getFileIconPath(filename: string): string {
  // 1. Exact filename match
  const byName = FILE_NAME_MAP[filename];
  if (byName) return `./icons/${byName}`;

  // 2. Compound extension match (e.g. "foo.test.ts")
  const lower = filename.toLowerCase();
  for (const compoundExt of COMPOUND_KEYS) {
    if (lower.endsWith(`.${compoundExt}`)) {
      return `./icons/${COMPOUND_EXT_MAP[compoundExt]}`;
    }
  }

  // 3. Simple extension match
  const dotIdx = lower.lastIndexOf(".");
  if (dotIdx !== -1) {
    const ext = lower.slice(dotIdx + 1);
    const byExt = EXT_MAP[ext];
    if (byExt) return `./icons/${byExt}`;
  }

  // 4. Fallback
  return `./icons/${DEFAULT_FILE_ICON}`;
}

export function getFolderIconPath(folderName: string): string {
  // Use the last segment for compound folder names like "src/components"
  const name = folderName.includes("/") ? folderName.split("/").pop()! : folderName;
  const byName = FOLDER_NAME_MAP[name];
  return `./icons/${byName ?? DEFAULT_FOLDER_ICON}`;
}

export function FileTypeIcon({
  filename,
  isFolder,
  className,
}: {
  filename: string;
  isFolder?: boolean;
  className?: string;
}) {
  const src = isFolder ? getFolderIconPath(filename) : getFileIconPath(filename);
  return <img src={src} alt="" className={className} />;
}
