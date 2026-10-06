import { describe, expect, it } from 'vitest';
import { deploymentPollInterval, POLL_LIVE_MS, POLL_SETTLED_MS } from './pollInterval';

describe('deploymentPollInterval', () => {
  it('polls fast while work is in flight', () => {
    expect(deploymentPollInterval('PENDING')).toBe(POLL_LIVE_MS);
    expect(deploymentPollInterval('VALIDATING')).toBe(POLL_LIVE_MS);
    expect(deploymentPollInterval('DEPLOYING')).toBe(POLL_LIVE_MS);
    expect(deploymentPollInterval(undefined)).toBe(POLL_LIVE_MS);
  });

  it('polls slowly while settled, because HEALTHY and DEGRADED can still change', () => {
    expect(deploymentPollInterval('HEALTHY')).toBe(POLL_SETTLED_MS);
    expect(deploymentPollInterval('DEGRADED')).toBe(POLL_SETTLED_MS);
  });

  it('polls fast again while a rollback is waiting', () => {
    expect(deploymentPollInterval('HEALTHY', true)).toBe(POLL_LIVE_MS);
  });

  it('stops in final states', () => {
    expect(deploymentPollInterval('FAILED')).toBe(false);
    expect(deploymentPollInterval('ROLLED_BACK', true)).toBe(false);
  });
});
