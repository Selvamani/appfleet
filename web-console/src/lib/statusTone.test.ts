import { describe, expect, it } from 'vitest';
import { isFinal, isLive, statusTone } from './statusTone';

describe('statusTone', () => {
  it('maps every deployment state to a tone', () => {
    expect(statusTone('PENDING')).toBe('progress');
    expect(statusTone('DEPLOYING')).toBe('progress');
    expect(statusTone('HEALTHY')).toBe('settled');
    expect(statusTone('DEGRADED')).toBe('attention');
    expect(statusTone('FAILED')).toBe('attention');
    expect(statusTone('ROLLED_BACK')).toBe('ended');
  });

  it('falls back to ended for unknown words', () => {
    expect(statusTone('SOMETHING_NEW')).toBe('ended');
  });

  it('knows which states are live and which are final', () => {
    expect(isLive('VALIDATING')).toBe(true);
    expect(isLive('HEALTHY')).toBe(false);
    expect(isFinal('ROLLED_BACK')).toBe(true);
    expect(isFinal('DEGRADED')).toBe(false);
  });
});
