import { Card, Muted } from '../../components';
import { cx } from '../../lib/cx';
import { formatTime } from '../../lib/format';
import type { LogEntry } from './useLoginSession';
import s from './login.module.css';

/** Every call this screen has made, newest first, with the status the service answered and its correlation id. */
export function EventLog({ entries }: { entries: LogEntry[] }) {
  return (
    <Card title="What happened" titleId="login-log-title">
      {entries.length === 0 ? (
        <p className={s.empty}>Nothing yet. Every call this screen makes will be listed here with its answer.</p>
      ) : (
        <ol className={s.log} aria-labelledby="login-log-title">
          {entries.map(e => (
            <li key={e.id} className={s.logItem}>
              <span className={s.logTime}>{formatTime(e.at)}</span>
              <span className={s.logHead}>
                <span className={s.logAction}>{e.action}</span>
                <span className={cx(s.status, e.ok ? s.statusOk : s.statusBad)} aria-label={e.status ? `Status ${e.status}` : 'No answer'}>
                  {e.status || 'no answer'}
                </span>
              </span>
              <span className={s.logBody}>
                <span>{e.summary}</span>
                {e.correlationId && <Muted><span className={s.cid}>correlation id {e.correlationId}</span></Muted>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}