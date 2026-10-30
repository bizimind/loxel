import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { EMPTY_SCHEMA_CONSENT_STATE } from "@/api/schema-consent-model";

const decisions: unknown[][] = [];
const switches: boolean[] = [];

await mock.module("@/api/client", () => ({
  decideSchemaConsent: async (...args: unknown[]) => {
    decisions.push(args);
  },
  setSchemaNeverFetch: async (neverFetch: boolean) => {
    switches.push(neverFetch);
  },
}));

const { useSchemaConsentStore } = await import("@/store/schema-consent");
const { SchemaConsentPrompt } = await import("./SchemaConsentPrompt");
const { SecuritySection } = await import("./SecuritySection");

const URL_A = "https://schemas.example.com/a.json";
const URL_B = "http://10.0.0.1/b.xsd";

beforeEach(() => {
  decisions.length = 0;
  switches.length = 0;
  useSchemaConsentStore.setState(EMPTY_SCHEMA_CONSENT_STATE);
});

afterEach(cleanup);

describe("SchemaConsentPrompt", () => {
  test("stays hidden with nothing waiting", () => {
    render(<SchemaConsentPrompt />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  test("shows the whole address and records each choice", () => {
    useSchemaConsentStore.setState({ pending: [URL_A, URL_B] });
    render(<SchemaConsentPrompt />);
    expect(screen.getByText(URL_A)).toBeTruthy();
    expect(screen.getByText(/1 of 2/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(decisions).toEqual([[URL_A, "trust"]]);
    fireEvent.click(screen.getByRole("button", { name: "Don't fetch" }));
    expect(decisions.at(-1)).toEqual([URL_A, "deny"]);
    fireEvent.click(screen.getByRole("button", { name: "Never ask" }));
    expect(switches).toEqual([true]);
  });

  test("moves on when the server settles a prompt, from any window", () => {
    useSchemaConsentStore.setState({ pending: [URL_A, URL_B] });
    render(<SchemaConsentPrompt />);
    act(() => useSchemaConsentStore.setState({ pending: [URL_B] }));
    expect(screen.getByText(URL_B)).toBeTruthy();
    act(() => useSchemaConsentStore.setState({ pending: [] }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("SecuritySection", () => {
  test("lists decisions, each removable", () => {
    useSchemaConsentStore.setState({ trusted: [URL_A], denied: [URL_B] });
    render(<SecuritySection />);
    expect(screen.getByText("Trusted")).toBeTruthy();
    expect(screen.getByText("Denied")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Forget ${URL_B}` }));
    expect(decisions).toEqual([[URL_B, null]]);
  });

  test("has the never-fetch switch", () => {
    render(<SecuritySection />);
    fireEvent.click(screen.getByRole("switch", { name: "Never fetch schemas named by files" }));
    expect(switches).toEqual([true]);
  });
});
