import { useState, type FormEvent } from 'react';
import type { AuditFilter } from '../../api/types';
import { Button, Card, SelectField, TextField } from '../../components';
import s from './audit.module.css';

/** Actions the audit trail records (FR-6.1). The API filters on the exact name. */
export const AUDIT_ACTIONS = [
  'DEPLOYMENT_REQUESTED',
  'ROLLBACK_REQUESTED',
  'RELEASE_REGISTERED',
  'APPLICATION_CREATED',
  'GRANT_ADDED',
  'GRANT_REVOKED',
  'USER_DEACTIVATED',
  'KEY_ROTATED',
  'DLQ_REPLAYED',
  'TASK_RECLAIMED',
  'NODE_DRAINED',
  'SESSION_STARTED',
  'SESSION_ENDED',
  'LOGIN_FAILED',
] as const;

/**
 * The filter form. It holds its own draft and applies it on submit; the page keys it on the URL, so
 * a new URL (Clear, a "Find in audit trail" link) starts a fresh draft.
 */
export function AuditFilters({ applied, onApply, onClear }: {
  applied: AuditFilter;
  onApply: (filter: AuditFilter) => void;
  onClear: () => void;
}) {
  const [actor, setActor] = useState(applied.actor ?? '');
  const [action, setAction] = useState(applied.action ?? '');
  const [object, setObject] = useState(applied.object ?? '');
  const [cid, setCid] = useState(applied.correlationId ?? '');
  const actions: string[] = [...AUDIT_ACTIONS];
  if (applied.action && !actions.includes(applied.action)) actions.push(applied.action);
  const anyApplied = Boolean(applied.actor || applied.action || applied.object || applied.correlationId);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onApply({ actor: actor.trim(), action, object: object.trim(), correlationId: cid.trim() });
  };

  const clear = () => {
    setActor('');
    setAction('');
    setObject('');
    setCid('');
    onClear();
  };

  return (
    <Card as="div">
      <form aria-label="Filter audit events" onSubmit={submit}>
        <div className={s.filters}>
          <TextField label="Actor" placeholder="User or service" value={actor} onChange={e => setActor(e.target.value)} autoComplete="off" />
          <SelectField label="Action" value={action} onChange={e => setAction(e.target.value)}>
            <option value="">Any action</option>
            {actions.map(a => <option key={a} value={a}>{a}</option>)}
          </SelectField>
          <TextField label="Object" placeholder="Application, user or node" value={object} onChange={e => setObject(e.target.value)} autoComplete="off" />
          <TextField
            label="Correlation id"
            placeholder="c-…"
            value={cid}
            onChange={e => setCid(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className={s.filterActions}>
          <Button type="submit" variant="primary">Apply filters</Button>
          <Button onClick={clear} disabled={!anyApplied && !actor && !action && !object && !cid}>Clear</Button>
          <span className={s.note}>Records are written even when the action fails, so denied and failed attempts are here too.</span>
        </div>
      </form>
    </Card>
  );
}
