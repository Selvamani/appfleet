import { cx } from '../lib/cx';
import { statusTone } from '../lib/statusTone';
import s from './StatusChip.module.css';

/**
 * A status word with its tone. The word is always visible, so colour is never the only signal.
 * The only consumer of statusTone().
 */
export function StatusChip({ status, label }: { status: string; label?: string }) {
  return <span className={cx(s.chip, s[statusTone(status)])}>{label ?? status}</span>;
}
