import { BUILT_IN_ROLES, type Role } from '../api/types';

/**
 * Development-only "preview as" role (plan §8.8). The mock identity service issues a user with this
 * role; the real identity-service (S4) replaces all of this.
 */
export const DEV_ROLES: Role[] = [...BUILT_IN_ROLES];
const STORAGE_KEY = 'appfleet.dev.role';
let memoryRole: Role = 'DEPLOYER';

function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (DEV_ROLES as string[]).includes(v);
}

export function getDevRole(): Role {
  try {
    const fromUrl = new URLSearchParams(globalThis.location?.search ?? '').get('as');
    if (isRole(fromUrl)) {
      globalThis.localStorage?.setItem(STORAGE_KEY, fromUrl);
      return fromUrl;
    }
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (isRole(stored)) return stored;
  } catch {
    // storage unavailable: fall back to memory
  }
  return memoryRole;
}

export function setDevRole(role: Role): void {
  memoryRole = role;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, role);
  } catch {
    // storage unavailable
  }
}
