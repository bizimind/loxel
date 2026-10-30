import { describe, expect, test } from "bun:test";

import type { SchemaConsentState } from "@/api/schema-consent-model";

import { normalizeSchemaUrl, SchemaConsent } from "./schema-consent";

const URL_A = "https://schemas.example.com/a.json";
const URL_B = "https://other.example.org/b.json";

function setup(initial: string | null = null) {
  let saved = initial;
  const states: SchemaConsentState[] = [];
  const decisions: unknown[] = [];
  const consent = new SchemaConsent({
    load: () => saved,
    save: (json) => {
      saved = json;
    },
    onStateChanged: (state) => states.push(state),
    onDecision: (change) => decisions.push(change),
  });
  consent.setConfigured([]);
  return { consent, states, decisions, saved: () => saved };
}

describe("normalizeSchemaUrl", () => {
  test("keeps HTTP(S) URLs without their fragment", () => {
    expect(normalizeSchemaUrl(`${URL_A}#/definitions/x`)).toBe(URL_A);
  });

  test("refuses everything else", () => {
    expect(normalizeSchemaUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeSchemaUrl("./local.json")).toBeNull();
    expect(normalizeSchemaUrl(`https://example.com/${"a".repeat(3000)}`)).toBeNull();
  });
});

describe("SchemaConsent", () => {
  test("an unknown URL is undecided and asks once", () => {
    const { consent } = setup();
    expect(consent.request(URL_A)).toBe("undecided");
    expect(consent.request(URL_A)).toBe("undecided");
    expect(consent.state().pending).toEqual([URL_A]);
  });

  test("a URL that is not HTTP(S) is denied without asking", () => {
    const { consent } = setup();
    expect(consent.request("ftp://example.com/a.json")).toBe("denied");
    expect(consent.state().pending).toEqual([]);
  });

  test("trusting allows the URL, settles the prompt and reports it", () => {
    const { consent, decisions } = setup();
    consent.request(URL_A);
    consent.decide(URL_A, "trust");
    expect(consent.check(URL_A)).toBe("allowed");
    expect(consent.state().pending).toEqual([]);
    expect(decisions).toEqual([{ trusted: URL_A }]);
  });

  test("denying keeps the URL from being fetched or asked about again", () => {
    const { consent } = setup();
    consent.request(URL_A);
    consent.decide(URL_A, "deny");
    expect(consent.request(URL_A)).toBe("denied");
    expect(consent.state().pending).toEqual([]);
  });

  test("forgetting a decision asks again", () => {
    const { consent, decisions } = setup();
    consent.decide(URL_A, "trust");
    consent.decide(URL_A, null);
    expect(decisions).toEqual([{ trusted: URL_A }, "revoked"]);
    expect(consent.request(URL_A)).toBe("undecided");
  });

  test("never fetch denies trusted URLs and undecided ones, without asking", () => {
    const { consent, decisions } = setup();
    consent.decide(URL_A, "trust");
    consent.request(URL_B);
    consent.setNeverFetch(true);
    expect(consent.check(URL_A)).toBe("denied");
    expect(consent.request(URL_B)).toBe("denied");
    expect(consent.state().pending).toEqual([]);
    expect(decisions.at(-1)).toBe("revoked");

    consent.setNeverFetch(false);
    expect(consent.check(URL_A)).toBe("allowed");
  });

  test("configured URLs are allowed without asking, whatever the switch says", () => {
    const { consent } = setup();
    consent.setNeverFetch(true);
    consent.setConfigured([URL_A]);
    expect(consent.request(URL_A)).toBe("allowed");
    consent.setConfigured([]);
    expect(consent.request(URL_A)).toBe("denied");
  });

  test("windows are not asked until the configured URLs are known", () => {
    const states: SchemaConsentState[] = [];
    const consent = new SchemaConsent({
      load: () => null,
      save: () => {},
      onStateChanged: (state) => states.push(state),
      onDecision: () => {},
    });
    consent.request(URL_A);
    consent.request(URL_B);
    expect(consent.state().pending).toEqual([]);

    consent.setConfigured([URL_A]);
    expect(consent.state().pending).toEqual([URL_B]);
  });

  test("same-origin references share their schema's verdict, others ask", () => {
    const { consent } = setup();
    const sibling = "https://schemas.example.com/partial.json";
    consent.decide(URL_A, "trust");
    consent.addReferences(URL_A, [sibling, URL_B]);
    expect(consent.check(sibling)).toBe("allowed");
    expect(consent.check(URL_B)).toBe("undecided");

    consent.decide(URL_A, null);
    expect(consent.check(sibling)).toBe("undecided");
  });

  test("references of an undecided schema are not allowed", () => {
    const { consent } = setup();
    const sibling = "https://schemas.example.com/partial.json";
    consent.addReferences(URL_A, [sibling]);
    expect(consent.check(sibling)).toBe("undecided");
  });

  test("chosen hosts are the configured and trusted ones", () => {
    const { consent } = setup();
    consent.setConfigured(["http://localhost:8000/config.json"]);
    consent.decide(URL_A, "trust");
    consent.decide(URL_B, "deny");
    expect(consent.chosenHosts()).toEqual(["localhost", "schemas.example.com"]);
    consent.setNeverFetch(true);
    expect(consent.chosenHosts()).toEqual(["localhost"]);
  });

  test("decisions persist", () => {
    const first = setup();
    first.consent.decide(URL_A, "trust");
    first.consent.decide(URL_B, "deny");
    first.consent.setNeverFetch(false);

    const second = setup(first.saved());
    expect(second.consent.check(URL_A)).toBe("allowed");
    expect(second.consent.check(URL_B)).toBe("denied");
  });

  test("unreadable decisions trust nothing", () => {
    const { consent } = setup("{not json");
    expect(consent.check(URL_A)).toBe("undecided");
    const wrongShape = setup(JSON.stringify({ trusted: "everything" }));
    expect(wrongShape.consent.check(URL_A)).toBe("undecided");
  });

  test("the number of prompts is bounded", () => {
    const { consent } = setup();
    for (let i = 0; i < 200; i++) consent.request(`https://example.com/${i}.json`);
    expect(consent.state().pending.length).toBe(50);
  });
});
