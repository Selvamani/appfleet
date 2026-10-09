import { describe, expect, it } from 'vitest';
import { fakeJwt } from '../test/jwt';
import { decodeJwt, secondsLeft } from './jwt';

describe('decodeJwt', () => {
  it('reads the header and the claims', () => {
    const decoded = decodeJwt(fakeJwt({ sub: 'u1', jti: 'j1', teams: { t1: ['deployment:create'] } }));
    expect(decoded?.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decoded?.claims.sub).toBe('u1');
    expect(decoded?.claims.teams).toEqual({ t1: ['deployment:create'] });
  });

  it('reads non-ASCII text correctly', () => {
    expect(decodeJwt(fakeJwt({ sub: 'Zoë' }))?.claims.sub).toBe('Zoë');
  });

  it('returns null for something that is not a JWT', () => {
    expect(decodeJwt('not-a-token')).toBeNull();
    expect(decodeJwt('a.b')).toBeNull();
    expect(decodeJwt('a.b.c')).toBeNull();
    expect(decodeJwt('')).toBeNull();
  });

  it('returns null when the payload is not an object', () => {
    const part = (value: unknown) => btoa(JSON.stringify(value));
    expect(decodeJwt(`${part({ alg: 'RS256' })}.${part('text')}.s`)).toBeNull();
  });
});

describe('secondsLeft', () => {
  it('counts down to exp and goes negative after it', () => {
    const now = Date.UTC(2026, 9, 7, 12, 0, 0);
    expect(secondsLeft({ exp: now / 1000 + 900 }, now)).toBe(900);
    expect(secondsLeft({ exp: now / 1000 - 5 }, now)).toBe(-5);
  });

  it('is null without an exp', () => {
    expect(secondsLeft({})).toBeNull();
  });
});