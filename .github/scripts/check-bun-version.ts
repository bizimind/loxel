const expectedVersion = (await Bun.file(".bun-version").text()).trim();

const errors: string[] = [];

if (Bun.version !== expectedVersion) {
  errors.push(`running Bun ${Bun.version}; expected ${expectedVersion}`);
}

const bakeFile = "packages/sandbox/images/docker-bake.hcl";
const bakeConfig = await Bun.file(bakeFile).text();
const sandboxVersion = bakeConfig.match(/variable "BUN_VERSION"\s*\{ default = "([^"]+)" \}/)?.[1];
if (sandboxVersion !== expectedVersion) {
  errors.push(`${bakeFile} pins ${sandboxVersion ?? "no version"}; expected ${expectedVersion}`);
}

const workflowGlob = new Bun.Glob("*.yml");
for await (const workflow of workflowGlob.scan(".github/workflows")) {
  const path = `.github/workflows/${workflow}`;
  const contents = await Bun.file(path).text();
  const setupCount = contents.match(/uses: oven-sh\/setup-bun@/g)?.length ?? 0;
  const versionFileCount =
    contents.match(/bun-version-file: (?:main-scripts\/)?\.bun-version/g)?.length ?? 0;
  if (setupCount !== versionFileCount) {
    errors.push(
      `${path} has ${setupCount} setup-bun steps but ${versionFileCount} version-file inputs`,
    );
  }
}

const packageGlob = new Bun.Glob("{package.json,packages/*/package.json}");
for await (const packageFile of packageGlob.scan(".")) {
  const packageJson = await Bun.file(packageFile).json();
  const bunTypes = packageJson.devDependencies?.["@types/bun"];
  if (bunTypes !== undefined && bunTypes !== expectedVersion) {
    errors.push(`${packageFile} pins @types/bun ${bunTypes}; expected ${expectedVersion}`);
  }
}

if (errors.length > 0) {
  throw new Error(`Bun version declarations have drifted:\n- ${errors.join("\n- ")}`);
}

console.log(`Bun runtime, types, workflows, and sandbox are aligned at ${expectedVersion}`);
