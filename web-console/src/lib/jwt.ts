/** What an Appfleet access token carries (control-api S4.1, claim contract). */
export interface AccessClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  jti?: string;
  iat?: number;
  exp?: number;
  /** Team id to the permissions held on that team. Absent when the user has no grants. */
  teams?: Record<string, string[]>;
  /** Permissions held on every team. */
  perms?: string[];
  [claim: string]: unknown;
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  claims: AccessClaims;
}

function base64UrlToText(part: string): string {
  const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Reads a JWT without checking it. The console never verifies a token (it has no key and must not trust itself);
 * it only shows what the token says, and the server decides whether it is valid.
 */
export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(base64UrlToText(parts[0])) as Record<string, unknown>;
    const claims = JSON.parse(base64UrlToText(parts[1])) as AccessClaims;
    if (typeof header !== 'object' || header === null || typeof claims !== 'object' || claims === null) return null;
    return { header, claims };
  } catch {
    return null;
  }
}

/** Seconds from now until the token's `exp` (negative when it has passed), or null when it has no exp. */
export function secondsLeft(claims: AccessClaims, now: number = Date.now()): number | null {
  return typeof claims.exp === 'number' ? Math.floor(claims.exp - now / 1000) : null;
}