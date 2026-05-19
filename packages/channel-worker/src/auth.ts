import type { AppLogger } from "@bizimind/logger";

import * as jose from "jose";

/**
 * JWT claims structure.
 */
export interface JwtClaims {
  /** Subject (user ID) - required */
  sub: string;
  /** Issuer */
  iss?: string;
  /** Audience */
  aud?: string | string[];
  /** Issued at (Unix timestamp) */
  iat?: number;
  /** Expiration (Unix timestamp) - required */
  exp: number;
  /** Not before (Unix timestamp) */
  nbf?: number;
  /** Additional custom claims */
  [key: string]: unknown;
}

/**
 * Result of JWT validation.
 */
export interface JwtValidationResult {
  valid: boolean;
  claims?: JwtClaims;
  error?: string;
}

/**
 * Cached JWKS data with expiration.
 */
interface CachedJwks {
  keys: jose.JWK[];
  fetchedAt: number;
}

// In-memory cache for JWKS (survives within isolate lifetime)
const jwksMemoryCache = new Map<string, CachedJwks>();

// Cache TTL: 1 hour (JWKS doesn't change frequently)
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Fetch JWKS with caching.
 * Uses in-memory cache with TTL, falls back to direct fetch.
 */
async function fetchJwks(jwksUrl: string, logger?: AppLogger): Promise<jose.JWK[]> {
  const now = Date.now();

  // Check in-memory cache first
  const cached = jwksMemoryCache.get(jwksUrl);
  if (cached && now - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.keys;
  }
  const response = await fetch(jwksUrl, { headers: { Accept: "application/json" } });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    logger?.error("JWKS fetch failed", {
      url: jwksUrl,
      status: response.status,
      statusText: response.statusText,
      body: text.slice(0, 200),
    });
    throw new Error(`JWKS fetch failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { keys: jose.JWK[] };

  // Cache the result
  jwksMemoryCache.set(jwksUrl, { keys: data.keys, fetchedAt: now });

  return data.keys;
}

/**
 * Create a local JWKS keyset from cached keys.
 */
function createLocalJwks(keys: jose.JWK[]): jose.JWTVerifyGetKey {
  const jwks = jose.createLocalJWKSet({ keys });
  return jwks;
}

/**
 * Validate a JWT token using JWKS.
 *
 * @param token The JWT token string
 * @param jwksUrl The URL to fetch JWKS from
 * @param issuer Expected issuer to validate
 * @param logger Optional logger for error reporting
 * @returns Validation result with claims if valid
 */
export async function validateJwt(
  token: string,
  jwksUrl: string,
  issuer: string,
  logger?: AppLogger,
): Promise<JwtValidationResult> {
  try {
    // Fetch JWKS (uses cache if available)
    const keys = await fetchJwks(jwksUrl, logger);
    const jwks = createLocalJwks(keys);

    const { payload } = await jose.jwtVerify(token, jwks, {
      issuer,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp"],

      // Allow 5 seconds of clock skew between servers
      clockTolerance: 5,
    });

    return { valid: true, claims: payload as JwtClaims };
  } catch (error) {
    if (error instanceof jose.errors.JWTExpired) {
      return { valid: false, error: "Token expired" };
    }
    if (error instanceof jose.errors.JWTClaimValidationFailed) {
      return { valid: false, error: "Claim validation failed" };
    }
    if (error instanceof jose.errors.JWSSignatureVerificationFailed) {
      return { valid: false, error: "Invalid signature" };
    }
    if (error instanceof jose.errors.JOSEError) {
      return { valid: false, error: "Token validation failed" };
    }
    return { valid: false, error: "Authentication failed" };
  }
}

/**
 * Debug function to test JWKS connectivity.
 * Returns details about the fetch attempt.
 */
export async function debugJwks(
  jwksUrl: string,
): Promise<{
  success: boolean;
  status?: number;
  keyCount?: number;
  error?: string;
  cached: boolean;
}> {
  const cached = jwksMemoryCache.get(jwksUrl);
  const isCached = cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS;

  if (isCached) {
    return { success: true, keyCount: cached!.keys.length, cached: true };
  }

  try {
    const response = await fetch(jwksUrl, { headers: { Accept: "application/json" } });

    if (!response.ok) {
      return { success: false, status: response.status, error: response.statusText, cached: false };
    }

    const data = (await response.json()) as { keys: jose.JWK[] };
    return {
      success: true,
      status: response.status,
      keyCount: data.keys?.length ?? 0,
      cached: false,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      cached: false,
    };
  }
}
