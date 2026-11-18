/**
 * Fails when a vulnerability Trivy found in Loxel's SBOM scores above the CVSS threshold:
 *
 *   bun scripts/sbom-vuln-gate.ts <trivy-report.json>
 *
 * The report is `trivy sbom --format json` of an SBOM from sbom.ts, with `.trivyignore` applied.
 * Trivy filters by severity label only, hence this script. It prints counts per severity and the
 * IDs that fail (workflow logs are public), and needs no installed packages. The rule is the
 * constants below; packages/loxel/docs/ELECTRON.md explains it.
 */

/** A finding fails when its CVSS score is above this. */
export const CVSS_THRESHOLD = 4.0;
/** Labels that fail a finding with no CVSS score: MEDIUM starts at 4.0, LOW ends at 3.9. */
const FAILING_LABELS = new Set(["MEDIUM", "HIGH", "CRITICAL"]);
/** Whether a finding with neither a score nor a label fails, or only warns. */
const UNRATED_FAILS = false;

const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;

export interface Vulnerability {
  VulnerabilityID: string;
  Severity: (typeof SEVERITIES)[number];
  /** Where Trivy took the label from, usually the vendor. */
  SeveritySource?: string;
  CVSS?: Record<string, { V3Score?: number; V40Score?: number }>;
}

export interface TrivyReport {
  Results?: Array<{ Vulnerabilities?: Vulnerability[] }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseVulnerability(value: unknown): Vulnerability {
  const severity = SEVERITIES.find((s) => isObject(value) && value.Severity === s);
  if (!isObject(value) || typeof value.VulnerabilityID !== "string" || !severity) {
    // The finding itself stays out of the message: logs are public.
    throw new Error("Trivy report holds a vulnerability without an ID or a known severity");
  }
  const cvss: NonNullable<Vulnerability["CVSS"]> = {};
  for (const [source, scores] of Object.entries(isObject(value.CVSS) ? value.CVSS : {})) {
    if (!isObject(scores)) continue;
    cvss[source] = {
      V3Score: optionalNumber(scores.V3Score),
      V40Score: optionalNumber(scores.V40Score),
    };
  }
  const source = value.SeveritySource;
  return {
    VulnerabilityID: value.VulnerabilityID,
    Severity: severity,
    ...(typeof source === "string" && { SeveritySource: source }),
    CVSS: cvss,
  };
}

/** Trivy's JSON narrowed to what the gate reads; any other shape throws, so the gate fails closed. */
export function parseReport(json: unknown): TrivyReport {
  const results = isObject(json) ? json.Results : undefined;
  if (results !== undefined && !Array.isArray(results))
    throw new Error("Trivy report's Results is not a list");
  return {
    Results: (results ?? []).map((result: unknown) => {
      const vulnerabilities = isObject(result) ? (result.Vulnerabilities ?? []) : [];
      if (!Array.isArray(vulnerabilities))
        throw new Error("A Trivy result's Vulnerabilities is not a list");
      return { Vulnerabilities: vulnerabilities.map(parseVulnerability) };
    }),
  };
}

/**
 * The CVSS score a finding is judged by: v4, else v3, from the label's source, else GHSA, else NVD,
 * else any other source.
 */
export function score(vulnerability: Vulnerability): number | undefined {
  const cvss = vulnerability.CVSS ?? {};
  const sources = [vulnerability.SeveritySource, "ghsa", "nvd", ...Object.keys(cvss)];
  for (const source of sources) {
    const scores = source === undefined ? undefined : cvss[source];
    const found = scores?.V40Score ?? scores?.V3Score;
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Whether a finding fails the gate, or is unrated (no score and no label). */
export function judge(vulnerability: Vulnerability): "pass" | "fail" | "unrated" {
  const cvss = score(vulnerability);
  if (cvss !== undefined) return cvss > CVSS_THRESHOLD ? "fail" : "pass";
  if (FAILING_LABELS.has(vulnerability.Severity)) return "fail";
  return vulnerability.Severity === "UNKNOWN" ? "unrated" : "pass";
}

/** Why a failing finding fails, for the log: `CVE-1 (CVSS 7.5)` or `CVE-1 (HIGH, no score)`. */
function failure(vulnerability: Vulnerability): string {
  const cvss = score(vulnerability);
  const why = cvss === undefined ? `${vulnerability.Severity}, no score` : `CVSS ${cvss}`;
  return `${vulnerability.VulnerabilityID} (${why})`;
}

/**
 * Counts each vulnerability ID once, and judges every package it is reported for: the score's
 * source can differ by ecosystem, so the worst one decides.
 */
export function gate(report: TrivyReport): {
  counts: Map<string, number>;
  failing: string[];
  unrated: number;
} {
  // Even a clean scan has a result per ecosystem; none means Trivy read no components.
  if (!report.Results?.length) throw new Error("Trivy scanned no components in the SBOM");
  const all = report.Results.flatMap((result) => result.Vulnerabilities ?? []);
  const counts = new Map<string, number>();
  const failing: string[] = [];
  let unrated = 0;
  for (const occurrences of Map.groupBy(all, (v) => v.VulnerabilityID).values()) {
    const severity = occurrences[0]?.Severity ?? "UNKNOWN";
    counts.set(severity, (counts.get(severity) ?? 0) + 1);
    const failed = occurrences.find(
      (v) => judge(v) === "fail" || (UNRATED_FAILS && judge(v) === "unrated"),
    );
    if (failed) failing.push(failure(failed));
    else if (occurrences.some((v) => judge(v) === "unrated")) unrated++;
  }
  return { counts, failing, unrated };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: bun scripts/sbom-vuln-gate.ts <trivy-report.json>");
  const { counts, failing, unrated } = gate(parseReport(await Bun.file(path).json()));
  console.log(`Findings by severity: ${JSON.stringify(Object.fromEntries(counts))}`);
  // Only a count: logs are public, and the IDs of findings that do not fail stay out of them.
  if (unrated > 0) console.log(`::warning::${unrated} finding(s) have no CVSS score or severity`);
  for (const finding of failing) console.log(`::error::${finding} fails the SBOM gate`);
  if (failing.length > 0) process.exit(1);
}
