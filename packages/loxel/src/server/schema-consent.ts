import {
  schemaConsentDecisionsSchema,
  type SchemaConsentDecision,
  type SchemaConsentDecisions,
  type SchemaConsentState,
} from "@/api/schema-consent-model";

import { logger } from "./logger";

const log = logger.child("schema-service");

/** Prompts held at once: a project naming thousands of URLs must not grow this without bound. */
const MAX_PENDING = 50;
const MAX_URL_LENGTH = 2048;

export type SchemaVerdict = "allowed" | "denied" | "undecided";

/** The HTTP(S) URL a decision is about, without its fragment; null for anything else. */
export function normalizeSchemaUrl(url: string): string | null {
  if (url.length > MAX_URL_LENGTH) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

export interface SchemaConsentOptions {
  /** The JSON {@link SchemaConsentOptions.save} last wrote, if any. */
  load: () => string | null;
  save: (json: string) => void;
  /** The state windows show changed. */
  onStateChanged: (state: SchemaConsentState) => void;
  /** The user decided something, so what may be fetched changed. */
  onDecision: (change: { trusted: string } | "revoked") => void;
}

/**
 * Decides whether a schema URL may be fetched. Schemas from Settings > Schemas and built-in ones are
 * the user's own choice and always may; anything else needs the user's decision, which is persisted
 * here. A schema's same-origin references count as part of it, so trusting a schema does not ask
 * again for each file it is split into, while a reference to another origin asks like any other URL.
 */
export class SchemaConsent {
  private decisions: SchemaConsentDecisions;
  private configured = new Set<string>();
  /** The schema(s) each referenced URL is part of. */
  private readonly referencedBy = new Map<string, Set<string>>();
  private readonly pending = new Set<string>();
  /** Windows are not asked until the first sync says which URLs are configured. */
  private configuredKnown = false;

  constructor(private readonly options: SchemaConsentOptions) {
    this.decisions = readDecisions(options.load);
  }

  state(): SchemaConsentState {
    return { ...this.decisions, pending: this.configuredKnown ? [...this.pending] : [] };
  }

  /** The hosts of the schemas the user chose: configured ones, and trusted ones unless switched off. */
  chosenHosts(): string[] {
    const urls = [...this.configured, ...(this.decisions.neverFetch ? [] : this.decisions.trusted)];
    return [...new Set(urls.map((url) => new URL(url).hostname))];
  }

  /** The verdict on a URL, without asking the user. */
  check(url: string): SchemaVerdict {
    const normalized = normalizeSchemaUrl(url);
    if (!normalized) return "denied";
    const direct = this.checkOne(normalized);
    if (direct !== "undecided") return direct;
    const roots = this.referencedBy.get(normalized);
    if (roots && [...roots].some((root) => this.checkOne(root) === "allowed")) return "allowed";
    return "undecided";
  }

  /** The verdict on a URL, asking the user when it has none yet. */
  request(url: string): SchemaVerdict {
    const verdict = this.check(url);
    if (verdict !== "undecided") return verdict;
    const normalized = normalizeSchemaUrl(url);
    if (!normalized || this.pending.has(normalized)) return verdict;
    if (this.pending.size >= MAX_PENDING) {
      log.warn("Too many schema URLs waiting for a decision", { url: normalized });
      return verdict;
    }
    this.pending.add(normalized);
    this.publish();
    return verdict;
  }

  /** Replace the configured URLs, from Settings > Schemas and the built-ins. */
  setConfigured(urls: readonly string[]): void {
    this.configured = new Set(urls.flatMap((url) => normalizeSchemaUrl(url) ?? []));
    this.configuredKnown = true;
    for (const url of this.pending) {
      if (this.check(url) !== "undecided") this.pending.delete(url);
    }
    this.publish();
  }

  /** Record what `root` references, keeping the same-origin URLs as part of it. */
  addReferences(root: string, references: readonly string[]): void {
    const normalizedRoot = normalizeSchemaUrl(root);
    if (!normalizedRoot) return;
    const { origin } = new URL(normalizedRoot);
    for (const reference of references) {
      const normalized = normalizeSchemaUrl(reference);
      if (!normalized || new URL(normalized).origin !== origin) continue;
      const roots = this.referencedBy.get(normalized) ?? new Set<string>();
      roots.add(normalizedRoot);
      this.referencedBy.set(normalized, roots);
    }
  }

  /** Record a decision on a URL; null forgets it, so the next use asks again. */
  decide(url: string, decision: SchemaConsentDecision | null): void {
    const normalized = normalizeSchemaUrl(url);
    if (!normalized) return;
    const wasTrusted = this.decisions.trusted.includes(normalized);
    const wasDenied = this.decisions.denied.includes(normalized);
    const trusted = this.decisions.trusted.filter((u) => u !== normalized);
    const denied = this.decisions.denied.filter((u) => u !== normalized);
    if (decision === "trust") trusted.push(normalized);
    if (decision === "deny") denied.push(normalized);
    this.decisions = { ...this.decisions, trusted, denied };
    this.pending.delete(normalized);
    this.options.save(JSON.stringify(this.decisions));
    this.publish();
    if (decision === "trust") this.options.onDecision({ trusted: normalized });
    else if (wasTrusted) this.options.onDecision("revoked");
    else if (decision === null && wasDenied) this.options.onDecision("revoked");
  }

  /** The "Never ask" switch. Turning it on also settles every open prompt. */
  setNeverFetch(neverFetch: boolean): void {
    if (neverFetch === this.decisions.neverFetch) return;
    this.decisions = { ...this.decisions, neverFetch };
    if (neverFetch) this.pending.clear();
    this.options.save(JSON.stringify(this.decisions));
    this.publish();
    this.options.onDecision("revoked");
  }

  private checkOne(normalized: string): SchemaVerdict {
    if (this.configured.has(normalized)) return "allowed";
    if (this.decisions.neverFetch) return "denied";
    if (this.decisions.trusted.includes(normalized)) return "allowed";
    if (this.decisions.denied.includes(normalized)) return "denied";
    return "undecided";
  }

  private publish(): void {
    this.options.onStateChanged(this.state());
  }
}

/** Read persisted decisions. Without readable ones nothing is trusted, so everything asks again. */
function readDecisions(load: () => string | null): SchemaConsentDecisions {
  const none = { trusted: [], denied: [], neverFetch: false };
  try {
    const raw = load();
    if (raw === null) return none;
    const parsed = schemaConsentDecisionsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    log.warn("Ignoring invalid schema decisions", { error: parsed.error });
  } catch (err) {
    log.warn("Ignoring unreadable schema decisions", {
      error: err instanceof Error ? err : undefined,
    });
  }
  return none;
}
