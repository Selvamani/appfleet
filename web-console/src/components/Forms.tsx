import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cx } from '../lib/cx';
import s from './Forms.module.css';

interface FieldFrameProps {
  label: ReactNode;
  hint?: ReactNode;
  /** Server or client message for this field; sets aria-invalid. */
  error?: string;
}

export function TextField({ label, hint, error, className, id, ...input }: FieldFrameProps & InputHTMLAttributes<HTMLInputElement>) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errId = error ? `${inputId}-err` : undefined;
  return (
    <div className={cx(s.field, className)}>
      <label className={s.label} htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        className={cx(s.control, error && s.invalid)}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errId].filter(Boolean).join(' ') || undefined}
        {...input}
      />
      {hint && <p id={hintId} className={s.hint}>{hint}</p>}
      {error && <p id={errId} className={s.error}>{error}</p>}
    </div>
  );
}

export function SelectField({ label, hint, error, className, id, children, ...select }: FieldFrameProps & SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const errId = error ? `${selectId}-err` : undefined;
  return (
    <div className={cx(s.field, className)}>
      <label className={s.label} htmlFor={selectId}>{label}</label>
      <select
        id={selectId}
        className={cx(s.control, error && s.invalid)}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errId].filter(Boolean).join(' ') || undefined}
        {...select}
      >
        {children}
      </select>
      {hint && <p id={hintId} className={s.hint}>{hint}</p>}
      {error && <p id={errId} className={s.error}>{error}</p>}
    </div>
  );
}

/** Search box with a visible-to-screen-readers label. */
export function SearchField({ label, className, ...input }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return <input type="search" aria-label={label} className={cx(s.control, s.search, className)} {...input} />;
}

/** A group of choices with a legend. */
export function Fieldset({ legend, children, className }: { legend: ReactNode; children: ReactNode; className?: string }) {
  return (
    <fieldset className={cx(s.fieldset, className)}>
      <legend className={s.label}>{legend}</legend>
      {children}
    </fieldset>
  );
}

/** A native radio inside a large clickable card. */
export function RadioCard({ name, value, checked, onChange, children, disabled }: {
  name: string; value: string; checked: boolean; onChange: (value: string) => void; children: ReactNode; disabled?: boolean;
}) {
  return (
    <label className={cx(s.radioCard, checked && s.checked, disabled && s.disabled)}>
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={() => onChange(value)} />
      <span className={s.radioBody}>{children}</span>
    </label>
  );
}

/** A large button with aria-pressed, for picking one of a few options (for example an environment). */
export function ToggleCard({ pressed, onClick, children, disabled }: { pressed: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className={cx(s.toggleCard, pressed && s.checked)} aria-pressed={pressed} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

/** Filter buttons with aria-pressed, inside a labelled group. */
export function Segmented<V extends string>({ label, options, value, onChange }: {
  label: string;
  options: Array<{ value: V; label: ReactNode }>;
  value: V;
  onChange: (value: V) => void;
}) {
  return (
    <div role="group" aria-label={label} className={s.segmented}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          className={cx(s.segment, o.value === value && s.segmentOn)}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
