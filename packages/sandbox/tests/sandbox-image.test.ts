import { describe, expect, test } from "bun:test";

import { createProvider } from "../src/create-provider.ts";
import { detectProviders } from "../src/detect.ts";
import type { ProviderType } from "../src/provider.ts";
import { SandboxTemplate } from "../src/sandbox-template.ts";

// Smoke-test the built sandbox image by running each tool inside a container
// via the SDK's streaming `spawn()` API.
//
// Prereqs:
//   - a container runtime is available and ready
//   - the target image is loaded into that runtime's image store
//
// Env overrides:
//   SANDBOX_IMAGE    — image reference to test (default: ghcr.io/bizimind/loxel/sandbox:latest)
//   SANDBOX_PROVIDER — force a specific provider instead of autoselecting

const IMAGE = process.env.SANDBOX_IMAGE ?? "ghcr.io/bizimind/loxel/sandbox:latest";
const VALID_PROVIDERS = ["apple", "podman", "docker"] as const satisfies readonly ProviderType[];
const FORCE_PROVIDER = VALID_PROVIDERS.find((p) => p === process.env.SANDBOX_PROVIDER);
if (process.env.SANDBOX_PROVIDER && !FORCE_PROVIDER) {
  throw new Error(
    `SANDBOX_PROVIDER="${process.env.SANDBOX_PROVIDER}" is not one of ${VALID_PROVIDERS.join(", ")}`,
  );
}

// Pick the first detected provider that has the image locally (or is able to
// pull it). This handles the common local-dev case where `docker buildx bake
// --load` puts the image in Docker even though Apple Containers is preferred.
async function selectProvider(): Promise<{ type: ProviderType } | { skipReason: string }> {
  const candidates = FORCE_PROVIDER ? [FORCE_PROVIDER] : detectProviders();
  if (candidates.length === 0) return { skipReason: "no container runtime detected" };

  const notReady: string[] = [];
  const missingImage: string[] = [];
  for (const type of candidates) {
    const provider = createProvider(type);
    try {
      await provider.ensureReady();
    } catch {
      notReady.push(type);
      continue;
    }
    if (await provider.imageExists(IMAGE)) return { type };
    try {
      await provider.pull(IMAGE);
      return { type };
    } catch {
      missingImage.push(type);
    }
  }

  const reasons: string[] = [];
  if (notReady.length > 0) reasons.push(`not ready: ${notReady.join(", ")}`);
  if (missingImage.length > 0) reasons.push(`image missing: ${missingImage.join(", ")}`);
  return {
    skipReason: `no provider can run ${IMAGE} (${reasons.join("; ")}) — run \`docker buildx bake sandbox --load\``,
  };
}

const selection = await selectProvider();
const providerType = "type" in selection ? selection.type : null;
const SKIP = providerType === null;
const SKIP_REASON = "skipReason" in selection ? selection.skipReason : undefined;

const TOOL_CHECKS: Array<{ name: string; cmd: string[]; match: RegExp }> = [
  { name: "ripgrep", cmd: ["rg", "--version"], match: /^ripgrep \d+\.\d+/ },
  { name: "fd", cmd: ["fd", "--version"], match: /^fd \d+\.\d+/ },
  { name: "python", cmd: ["python3", "--version"], match: /^Python 3\./ },
  { name: "go", cmd: ["go", "version"], match: /^go version go\d+\.\d+/ },
  { name: "aws-cli", cmd: ["aws", "--version"], match: /^aws-cli\/\d+\./ },
  { name: "node", cmd: ["node", "--version"], match: /^v\d+\.\d+/ },
  { name: "npm", cmd: ["npm", "--version"], match: /^\d+\.\d+/ },
  { name: "pnpm", cmd: ["pnpm", "--version"], match: /^\d+\.\d+/ },
  { name: "bun", cmd: ["bun", "--version"], match: /^\d+\.\d+/ },
  { name: "jq", cmd: ["jq", "--version"], match: /^jq-\d+\.\d+/ },
  { name: "git", cmd: ["git", "--version"], match: /^git version \d+\.\d+/ },
  { name: "gh", cmd: ["gh", "--version"], match: /^gh version \d+\.\d+/ },
  { name: "claude", cmd: ["claude", "--version"], match: /\d+\.\d+\.\d+/ },
  { name: "codex", cmd: ["codex", "--version"], match: /\d+\.\d+\.\d+/ },
  { name: "bat", cmd: ["bat", "--version"], match: /^bat \d+\.\d+/ },
  { name: "fzf", cmd: ["fzf", "--version"], match: /^\d+\.\d+/ },
  { name: "terraform", cmd: ["terraform", "-version"], match: /^Terraform v\d+\.\d+/ },
  {
    name: "kubectl",
    cmd: ["kubectl", "version", "--client=true", "--output=yaml"],
    match: /gitVersion: v\d+\.\d+/,
  },
  { name: "helm", cmd: ["helm", "version", "--short"], match: /^v\d+\.\d+/ },
  { name: "uv", cmd: ["uv", "--version"], match: /^uv \d+\.\d+/ },
  { name: "direnv", cmd: ["direnv", "version"], match: /^\d+\.\d+/ },
  { name: "tree", cmd: ["tree", "--version"], match: /^tree v?\d+\.\d+/ },
  { name: "wget", cmd: ["wget", "--version"], match: /^GNU Wget \d+\.\d+/ },
  { name: "unzip", cmd: ["unzip", "-v"], match: /^UnZip \d+\.\d+/ },
  { name: "make", cmd: ["make", "--version"], match: /^GNU Make \d+\.\d+/ },
  { name: "gcc", cmd: ["gcc", "--version"], match: /^gcc / },
  { name: "g++", cmd: ["g++", "--version"], match: /^g\+\+ / },
  { name: "zsh", cmd: ["zsh", "--version"], match: /^zsh \d+\.\d+/ },
  { name: "ssh", cmd: ["ssh", "-V"], match: /^OpenSSH_\d+\.\d+/ },
  { name: "gpg", cmd: ["gpg", "--version"], match: /^gpg \(GnuPG\) \d+\.\d+/ },
  {
    name: "oh-my-zsh",
    cmd: ["zsh", "-c", "source /opt/oh-my-zsh/oh-my-zsh.sh && echo OK=$ZSH"],
    match: /^OK=\/opt\/oh-my-zsh$/m,
  },
];

describe.skipIf(SKIP)(`sandbox image tools (${IMAGE})`, () => {
  for (const { name, cmd, match } of TOOL_CHECKS) {
    test(`${name}: \`${cmd.join(" ")}\``, async () => {
      const template = new SandboxTemplate(
        { name: "sandbox-image-test", image: IMAGE, command: ["sleep", "60"] },
        { providerType: providerType! },
      );
      const sandbox = await template.create();
      try {
        const handle = sandbox.spawn(cmd);
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(handle.stdout).text(),
          new Response(handle.stderr).text(),
          handle.exited,
        ]);
        const output = (stdout + stderr).trim();
        expect(exitCode, `exit ${exitCode}: ${output}`).toBe(0);
        expect(output).toMatch(match);
      } finally {
        await sandbox.destroy();
      }
    }, 60_000);
  }
});

if (SKIP_REASON) {
  // eslint-disable-next-line no-console
  console.warn(`[sandbox-image.test] skipping: ${SKIP_REASON}`);
}
