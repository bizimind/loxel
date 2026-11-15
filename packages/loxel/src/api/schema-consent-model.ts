import { z } from "zod";

/** The user's persisted decisions about schema URLs named by project files. */
export const schemaConsentDecisionsSchema = z.object({
  trusted: z.array(z.string()),
  denied: z.array(z.string()),
  /** "Never ask": no schema named by a file is fetched, trusted ones included. */
  neverFetch: z.boolean(),
});

export type SchemaConsentDecisions = z.infer<typeof schemaConsentDecisionsSchema>;

/** What a window shows: the decisions, and the URLs waiting for one. */
export const schemaConsentStateSchema = schemaConsentDecisionsSchema.extend({
  pending: z.array(z.string()),
});

export type SchemaConsentState = z.infer<typeof schemaConsentStateSchema>;

export type SchemaConsentDecision = "trust" | "deny";

export const EMPTY_SCHEMA_CONSENT_STATE: SchemaConsentState = {
  trusted: [],
  denied: [],
  neverFetch: false,
  pending: [],
};
