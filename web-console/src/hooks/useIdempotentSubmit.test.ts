import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useIdempotentSubmit } from './useIdempotentSubmit';

describe('useIdempotentSubmit', () => {
  it('keeps one key while the inputs stay the same', () => {
    const { result, rerender } = renderHook(({ inputs }) => useIdempotentSubmit(inputs), { initialProps: { inputs: 'a|2.4.0|prod' } });
    const first = result.current.idempotencyKey;
    rerender({ inputs: 'a|2.4.0|prod' });
    expect(result.current.idempotencyKey).toBe(first);
  });

  it('starts a new key when any input changes', () => {
    const { result, rerender } = renderHook(({ inputs }) => useIdempotentSubmit(inputs), { initialProps: { inputs: 'a|2.4.0|prod' } });
    const first = result.current.idempotencyKey;
    rerender({ inputs: 'a|2.4.0|staging' });
    expect(result.current.idempotencyKey).not.toBe(first);
  });

  it('renews on request', () => {
    const { result } = renderHook(() => useIdempotentSubmit('x'));
    const first = result.current.idempotencyKey;
    act(() => result.current.renew());
    expect(result.current.idempotencyKey).not.toBe(first);
  });
});
