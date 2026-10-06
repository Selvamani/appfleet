import type { ReactNode } from 'react';
import { cx } from '../lib/cx';
import { Button } from './Button';
import s from './Display.module.css';

export function StatTile({ label, value, detail }: { label: ReactNode; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className={s.tile}>
      <div className={s.tileLabel}>{label}</div>
      <div className={s.tileValue}>{value}</div>
      {detail && <div className={s.tileDetail}>{detail}</div>}
    </div>
  );
}

export function DetailList({ items, className }: { items: Array<[ReactNode, ReactNode]>; className?: string }) {
  return (
    <dl className={cx(s.dl, className)}>
      {items.map(([term, value], i) => (
        <div key={i} className={s.dlRow}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export type StepState = 'done' | 'current' | 'failed' | 'todo';

export interface Step {
  label: string;
  state: StepState;
  note?: string;
}

const STEP_WORDS: Record<StepState, string> = { done: 'Done', current: 'Current', failed: 'Failed here', todo: 'Not yet' };

/** An ordered sequence (for example the deployment FSM's happy path). */
export function Stepper({ steps, label }: { steps: Step[]; label: string }) {
  return (
    <ol className={s.steps} aria-label={label}>
      {steps.map(step => (
        <li key={step.label} className={cx(s.step, s[step.state])} aria-current={step.state === 'current' ? 'step' : undefined}>
          <b>{step.label}</b>
          <span>{step.note ?? STEP_WORDS[step.state]}</span>
        </li>
      ))}
    </ol>
  );
}

export interface TimelineItem {
  key: string;
  time: ReactNode;
  text: ReactNode;
  aside?: ReactNode;
}

export function Timeline({ items, label }: { items: TimelineItem[]; label: string }) {
  return (
    <ol className={s.timeline} aria-label={label}>
      {items.map(item => (
        <li key={item.key}>
          <span className={s.time}>{item.time}</span>
          <span>{item.text}</span>
          <span>{item.aside}</span>
        </li>
      ))}
    </ol>
  );
}

/** "Load older" for cursor lists. */
export function LoadMore({ hasMore, loading, onLoad, note }: { hasMore: boolean; loading: boolean; onLoad: () => void; note?: ReactNode }) {
  return (
    <div className={s.loadMore}>
      <span className={s.note}>{note ?? 'Newest first. Older rows load by cursor, so the list never skips or repeats rows.'}</span>
      {hasMore ? (
        <Button size="sm" onClick={onLoad} busy={loading} disabled={loading}>{loading ? 'Loading' : 'Load older'}</Button>
      ) : (
        <span className={s.note}>No older rows.</span>
      )}
    </div>
  );
}

/** Small mono text for ids, versions, hashes. */
export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return <code className={s.mono} title={title}>{children}</code>;
}
