import { describe, expect, test } from "bun:test";

import { gate, judge, parseReport, score, type Vulnerability } from "./sbom-vuln-gate";

function vulnerability(fields: Partial<Vulnerability>): Vulnerability {
  return { VulnerabilityID: "CVE-1", Severity: "UNKNOWN", ...fields };
}

describe("score", () => {
  test("prefers the label's source, then GHSA, then NVD, and v4 over v3", () => {
    const cvss = {
      nvd: { V3Score: 9.8 },
      ghsa: { V3Score: 7.5, V40Score: 8.7 },
      redhat: { V3Score: 3 },
    };
    expect(score(vulnerability({ SeveritySource: "redhat", CVSS: cvss }))).toBe(3);
    expect(score(vulnerability({ CVSS: cvss }))).toBe(8.7);
    expect(score(vulnerability({ CVSS: { nvd: { V3Score: 9.8 }, other: { V3Score: 1 } } }))).toBe(
      9.8,
    );
    expect(score(vulnerability({ CVSS: { other: { V3Score: 1 } } }))).toBe(1);
  });

  test("is undefined without CVSS data", () => {
    expect(score(vulnerability({}))).toBeUndefined();
  });
});

describe("judge", () => {
  test("fails a score above the threshold, not one at it", () => {
    expect(judge(vulnerability({ CVSS: { nvd: { V3Score: 4.1 } } }))).toBe("fail");
    expect(judge(vulnerability({ Severity: "HIGH", CVSS: { nvd: { V3Score: 4 } } }))).toBe("pass");
  });

  test("judges a finding with no score by its label", () => {
    expect(judge(vulnerability({ Severity: "MEDIUM" }))).toBe("fail");
    expect(judge(vulnerability({ Severity: "LOW" }))).toBe("pass");
    expect(judge(vulnerability({ Severity: "UNKNOWN" }))).toBe("unrated");
  });
});

describe("gate", () => {
  test("counts each vulnerability once and lists those that fail", () => {
    const high = vulnerability({ VulnerabilityID: "CVE-2", Severity: "HIGH" });
    const scored = vulnerability({ VulnerabilityID: "CVE-3", CVSS: { nvd: { V3Score: 5 } } });
    const report = {
      Results: [
        { Vulnerabilities: [high, scored, vulnerability({ VulnerabilityID: "GO-1" })] },
        { Vulnerabilities: [high] },
        {},
      ],
    };
    const { counts, failing, unrated } = gate(report);
    expect(Object.fromEntries(counts)).toEqual({ HIGH: 1, UNKNOWN: 2 });
    expect(failing).toEqual(["CVE-2 (HIGH, no score)", "CVE-3 (CVSS 5)"]);
    expect(unrated).toBe(1);
  });

  test("fails an ID when any package it is reported for fails", () => {
    const go = vulnerability({ Severity: "HIGH", CVSS: { nvd: { V3Score: 7.5 } } });
    const npm = vulnerability({ Severity: "LOW", CVSS: { ghsa: { V3Score: 3.7 } } });
    const report = { Results: [{ Vulnerabilities: [go] }, { Vulnerabilities: [npm] }] };
    expect(gate(report).failing).toEqual(["CVE-1 (CVSS 7.5)"]);
  });

  test("passes a clean scan and rejects one that read no components", () => {
    expect(gate({ Results: [{}] }).failing).toEqual([]);
    expect(() => gate({})).toThrow("no components");
  });
});

describe("parseReport", () => {
  test("keeps the fields the gate reads", () => {
    const json = {
      Results: [
        {
          Target: "Node.js",
          Vulnerabilities: [
            {
              VulnerabilityID: "CVE-1",
              Severity: "HIGH",
              SeveritySource: "ghsa",
              CVSS: { ghsa: { V3Score: 7.5, V3Vector: "x" } },
            },
          ],
        },
        { Target: "Go" },
      ],
    };
    expect(parseReport(json)).toEqual({
      Results: [
        {
          Vulnerabilities: [
            {
              VulnerabilityID: "CVE-1",
              Severity: "HIGH",
              SeveritySource: "ghsa",
              CVSS: { ghsa: { V3Score: 7.5, V40Score: undefined } },
            },
          ],
        },
        { Vulnerabilities: [] },
      ],
    });
  });

  test("rejects a shape it does not know, so the gate fails closed", () => {
    expect(() =>
      parseReport({ Results: [{ Vulnerabilities: [{ VulnerabilityID: "CVE-1" }] }] }),
    ).toThrow("known severity");
    expect(() =>
      parseReport({
        Results: [{ Vulnerabilities: [{ VulnerabilityID: "CVE-1", Severity: "SEVERE" }] }],
      }),
    ).toThrow();
    expect(() => parseReport({ Results: {} })).toThrow("not a list");
    expect(() => parseReport({ Results: [null] })).toThrow("not an object");
    expect(() => parseReport({ Results: [[]] })).toThrow("not an object");
  });
});
