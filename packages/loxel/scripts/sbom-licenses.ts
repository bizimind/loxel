/**
 * Fills in the licenses the SBOM's sources leave out, as sbom.ts's last steps: the overrides in
 * third-party.json; then, for components still without one, an npm package's legacy `licenses`
 * field, which pnpm does not read, and deps.dev's license for Go modules and Maven artifacts.
 */

import { readdirSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { Component } from "./sbom";

const DEPS_DEV = "https://api.deps.dev/v3/systems";
/** Lookups in flight at once, to be gentle with deps.dev. */
const DEPS_DEV_CONCURRENCY = 8;

/** The expressions joined by `operator`, each once, a compound one in parentheses. */
export function joinExpressions(expressions: string[], operator: "AND" | "OR"): string {
  const unique = [...new Set(expressions)];
  return unique
    .map((expression) => (expression.includes(" ") ? `(${expression})` : expression))
    .join(` ${operator} `);
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const hasLicense = (component: Component): boolean =>
  Array.isArray(component.licenses) && component.licenses.length > 0;
const withExpression = (component: Component, expression: string): Component => ({
  ...component,
  licenses: [{ expression }],
});

/**
 * The SPDX expression of an npm manifest's legacy license field: `license: { type }`, or a
 * `licenses` array of them, which npm reads as a choice (`MIT OR Apache-2.0`).
 */
export function legacyNpmLicense(packageJson: unknown): string | undefined {
  const typed = z.object({ type: z.string() });
  const { license, licenses } = z
    .object({
      license: typed.optional().catch(undefined),
      licenses: z.array(typed).optional().catch(undefined),
    })
    .parse(packageJson);
  const types = licenses?.length ? licenses.map(({ type }) => type) : license && [license.type];
  return types && joinExpressions(types, "OR");
}

/** Gives each unlicensed npm component the legacy license of its package in pnpm's `store`. */
export async function withNpmLegacyLicenses(
  components: Component[],
  store: string,
): Promise<Component[]> {
  const dirs = readdirSync(store);
  return Promise.all(
    components.map(async (component) => {
      if (hasLicense(component) || !text(component.purl).startsWith("pkg:npm/")) return component;
      const group = text(component.group);
      const name = group ? `${group}/${text(component.name)}` : text(component.name);
      // pnpm stores `@scope/name@1.0.0` as `@scope+name@1.0.0`, `_<hash>` appended for peers.
      const dir = `${name.replace("/", "+")}@${text(component.version)}`;
      const stored = dirs.find((entry) => entry === dir || entry.startsWith(`${dir}_`));
      if (!stored) return component;
      const manifest = path.join(store, stored, "node_modules", name, "package.json");
      const license = legacyNpmLicense(await Bun.file(manifest).json());
      return license ? withExpression(component, license) : component;
    }),
  );
}

/**
 * Where deps.dev has a Go module's or Maven artifact's licenses, and how they combine: a Go
 * module's are its license files, which all apply; a POM's several licenses are a choice.
 */
export function depsDevLookup(
  component: Component,
): { url: string; operator: "AND" | "OR" } | undefined {
  const purl = text(component.purl);
  const version = encodeURIComponent(text(component.version));
  const name = text(component.name);
  if (purl.startsWith("pkg:golang/")) {
    const url = `${DEPS_DEV}/go/packages/${encodeURIComponent(name)}/versions/${version}`;
    return { url, operator: "AND" };
  }
  if (purl.startsWith("pkg:maven/")) {
    const key = encodeURIComponent(`${text(component.group)}:${name}`);
    return { url: `${DEPS_DEV}/maven/packages/${key}/versions/${version}`, operator: "OR" };
  }
  return undefined;
}

/** deps.dev's SPDX licenses at `url`, or undefined when it cannot name them all. */
async function fetchDepsDevLicenses(url: string): Promise<string[] | undefined> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { licenses } = z.object({ licenses: z.array(z.string()) }).parse(await response.json());
  return licenses.length === 0 || licenses.includes("non-standard") ? undefined : licenses;
}

/**
 * Gives each unlicensed Go module and Maven artifact deps.dev's license. A failed lookup only
 * warns and leaves the component unlicensed, for the release's license check to judge.
 */
export async function withDepsDevLicenses(
  components: Component[],
  fetchLicenses: (url: string) => Promise<string[] | undefined> = fetchDepsDevLicenses,
): Promise<Component[]> {
  const result = [...components];
  const queue = components.flatMap((component, index) => {
    const lookup = hasLicense(component) ? undefined : depsDevLookup(component);
    return lookup ? [{ component, index, ...lookup }] : [];
  });
  const missing: string[] = [];
  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { component, index, url, operator } = job;
      const licenses = await fetchLicenses(url).catch((error: unknown) => {
        console.warn(`deps.dev lookup of ${component["bom-ref"]} failed: ${String(error)}`);
        return undefined;
      });
      if (licenses) result[index] = withExpression(component, joinExpressions(licenses, operator));
      else missing.push(component["bom-ref"]);
    }
  };
  await Promise.all(Array.from({ length: DEPS_DEV_CONCURRENCY }, worker));
  if (missing.length > 0) {
    console.warn(`No deps.dev license for:\n  ${missing.toSorted().join("\n  ")}`);
  }
  return result;
}

export const LicenseOverrideSchema = z.strictObject({
  /** The declared license, for a component whose metadata has none (or a wrong one). */
  license: z.string().optional(),
  /** The license chosen from the declared OR expression, recorded beside it. */
  concluded: z.string().optional(),
  note: z.string(),
});

export type LicenseOverride = z.infer<typeof LicenseOverrideSchema>;

/** The expression a component declares, from its first license choice. */
function declaredExpression(component: Component): string | undefined {
  const [choice] = z
    .array(
      z.object({
        expression: z.string().optional(),
        license: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
      }),
    )
    .catch([])
    .parse(component.licenses);
  return choice?.expression ?? choice?.license?.id ?? choice?.license?.name;
}

/** Applies the overrides, keyed by bom-ref. Throws when one matches no component. */
export function withLicenseOverrides(
  components: Component[],
  overrides: Record<string, LicenseOverride>,
): Component[] {
  const refs = new Set(components.map((component) => component["bom-ref"]));
  const stale = Object.keys(overrides).filter((ref) => !refs.has(ref));
  if (stale.length > 0) {
    throw new Error(`third-party.json overrides the license of no component: ${stale.join(", ")}`);
  }
  return components.map((component) => {
    const override = overrides[component["bom-ref"]];
    if (!override) return component;
    const declared = override.license ?? declaredExpression(component);
    if (!declared)
      throw new Error(`${component["bom-ref"]} has no declared license to conclude from`);
    if (!override.concluded) return withExpression(component, declared);
    return {
      ...component,
      licenses: [
        { expression: declared, acknowledgement: "declared" },
        { expression: override.concluded, acknowledgement: "concluded" },
      ],
    };
  });
}
