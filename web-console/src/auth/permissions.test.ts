import { describe, expect, it } from 'vitest';
import type { Me } from '../api/types';
import { can, visibleTeams } from './permissions';

const deployerOnPayments: Me = {
  id: 'u1', username: 'you', displayName: 'x', grants: [],
  permissions: { 'team-pay': ['deployment:read', 'deployment:create'] },
};
const operator: Me = { id: 'u2', username: 'op', displayName: 'x', grants: [], permissions: { '*': ['deployment:read', 'node:drain'] } };

describe('can', () => {
  it('allows a permission on the team it was granted for', () => {
    expect(can(deployerOnPayments, 'deployment:create', 'team-pay')).toBe(true);
  });

  it('refuses the same permission on another team', () => {
    expect(can(deployerOnPayments, 'deployment:create', 'team-search')).toBe(false);
  });

  it('answers "anywhere" when no team is given', () => {
    expect(can(deployerOnPayments, 'deployment:create')).toBe(true);
    expect(can(deployerOnPayments, 'node:drain')).toBe(false);
  });

  it('treats * as every team', () => {
    expect(can(operator, 'node:drain', 'team-search')).toBe(true);
  });

  it('refuses everything without a user', () => {
    expect(can(undefined, 'deployment:read')).toBe(false);
  });
});

describe('visibleTeams', () => {
  it('lists granted teams, or all', () => {
    expect(visibleTeams(deployerOnPayments)).toEqual(['team-pay']);
    expect(visibleTeams(operator)).toBe('all');
  });
});
