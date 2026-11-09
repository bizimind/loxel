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
    // `https://github.com@example.org/` reads as another host, and would send credentials.
    if (parsed.username || parsed.password) return null;
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
 * What a configured schema references or redirects to needs no decision, wherever it is.
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
    if (direct === "allowed" || this.decisions.denied.includes(normalized)) return direct;
    const viaRoot = this.roots(normalized).some((root) => this.checkOne(root) === "allowed");
    return viaRoot ? "allowed" : direct;
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

  /** Record what `root` references, keeping the URLs it may bring along as part of it. */
  addReferences(root: string, references: readonly string[]): void {
    const normalizedRoot = normalizeSchemaUrl(root);
    if (!normalizedRoot) return;
    const { origin } = new URL(normalizedRoot);
    const anyOrigin = [normalizedRoot, ...this.roots(normalizedRoot)].some((url) =>
      this.configured.has(url),
    );
    for (const reference of references) {
      const normalized = normalizeSchemaUrl(reference);
      if (!normalized || (!anyOrigin && new URL(normalized).origin !== origin)) continue;
      const roots = this.referencedBy.get(normalized) ?? new Set<string>();
      roots.add(normalizedRoot);
      this.referencedBy.set(normalized, roots);
    }
  }

  /**
   * Whether a download of `from` may follow its redirect to `to`, which counts as a reference: the
   * user allowed one address, and a redirect must not make that another one they never saw.
   */
  mayFollowRedirect(from: string, to: string): boolean {
    this.addReferences(from, [to]);
    return this.request(to) === "allowed";
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
    if (decision === "trust") {
      // Another window may have turned the switch on while this one still showed the prompt.
      if (this.check(normalized) === "allowed") this.options.onDecision({ trusted: normalized });
    } else if (wasTrusted) this.options.onDecision("revoked");
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

  /** The schemas `url` is transitively part of, not through any denied one. */
  private roots(url: string): string[] {
    const found = new Set<string>();
    const pending = [url];
    while (pending.length > 0) {
      for (const root of this.referencedBy.get(pending.pop()!) ?? []) {
        if (found.has(root) || this.decisions.denied.includes(root)) continue;
        found.add(root);
        pending.push(root);
      }
    }
    return [...found];
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
    if (parsed.success) {
      const urls = (list: string[]) => list.flatMap((url) => normalizeSchemaUrl(url) ?? []);
      const { trusted, denied, neverFetch } = parsed.data;
      return { trusted: urls(trusted), denied: urls(denied), neverFetch };
    }
    log.warn("Ignoring invalid schema decisions", { error: parsed.error });
  } catch (err) {
    log.warn("Ignoring unreadable schema decisions", {
      error: err instanceof Error ? err : undefined,
    });
  }
  return none;
}
