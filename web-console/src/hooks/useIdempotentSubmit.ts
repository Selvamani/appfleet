import { useCallback, useState } from 'react';
import { randomKey } from '../lib/uuid';

/**
 * One Idempotency-Key per logical submission (plan §8.3).
 *
 * The key stays the same for every retry of the same inputs, so a double click or a retry after a
 * timeout returns the first answer instead of deploying twice. Changing any input (inputsKey) starts
 * a new submission with a new key. Call renew() after a 422 idempotency-key-reused.
 */
export function useIdempotentSubmit(inputsKey: string) {
  const [state, setState] = useState(() => ({ inputsKey, key: randomKey() }));
  const renew = useCallback(() => setState(s => ({ ...s, key: randomKey() })), []);

  if (state.inputsKey !== inputsKey) {
    const next = { inputsKey, key: randomKey() };
    setState(next);
    return { idempotencyKey: next.key, renew };
  }
  return { idempotencyKey: state.key, renew };
}
