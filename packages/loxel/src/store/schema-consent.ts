import { create } from "zustand";

import { EMPTY_SCHEMA_CONSENT_STATE, type SchemaConsentState } from "@/api/schema-consent-model";

/** A mirror of the server's decisions on schema URLs; the server sends it on every change. */
export const useSchemaConsentStore = create<SchemaConsentState>()(() => EMPTY_SCHEMA_CONSENT_STATE);
