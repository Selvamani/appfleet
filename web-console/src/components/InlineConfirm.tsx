import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './Button';
import s from './InlineConfirm.module.css';

/**
 * A button that asks once before it acts, in place (no dialog). The confirm step takes focus when it
 * opens; Cancel or Escape closes it and gives focus back to the trigger. The step stays open, busy,
 * until onConfirm settles; the caller shows the outcome (and any error) next to it.

 */
export function InlineConfirm({
  trigger, triggerLabel, prompt, confirmLabel, onConfirm, disabled, variant = 'default', size = 'sm', returnFocusAfterConfirm = true,
}: {
  /** Visible text of the first button, for example "Drain". */
  trigger: string;
  /** Accessible name of the first button when the visible text needs its object, for example "Drain dev-node-01". */
  triggerLabel?: string;
  /** Visible question in the confirm step, for example "Drain dev-node-01?". */
  prompt: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  disabled?: boolean;
  variant?: 'default' | 'danger';
  size?: 'sm' | 'md';
  /**
   * After a successful confirm, focus goes back to the trigger (or to this control when the trigger is now
   * disabled). Pass false when the caller moves focus to the outcome itself. Cancel and failure always
   * return focus here.
   */
  returnFocusAfterConfirm?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Button does not take a ref, so focus moves through this wrapper: its first button is the confirm
  // button while open and the trigger while closed. When the trigger is disabled (the action is done,
  // for example a node now draining), the wrapper itself takes focus so it stays in the same place.
  const rootRef = useRef<HTMLSpanElement>(null);
  const moveFocus = useRef(false);

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    const root = rootRef.current;
    (root?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? root)?.focus();
  }, [open]);

  const toggle = (next: boolean, focus = true) => {
    moveFocus.current = focus;
    setOpen(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Escape' && !busy) {
      e.preventDefault();
      toggle(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    let ok = false;
    try {
      await onConfirm();
      ok = true;
    } catch {
      // The caller renders the error next to this control.
    } finally {
      setBusy(false);
      toggle(false, !ok || returnFocusAfterConfirm);
    }
  };

  const name = triggerLabel ?? trigger;

  return (
    <span ref={rootRef} className={s.root} tabIndex={-1}>
      {open ? (
        <span className={s.confirm} role="group" aria-label={`Confirm: ${name}`}>
          <span className={s.prompt}>{prompt}</span>
          <span className={s.buttons}>
            <Button
              size={size}
              variant={variant === 'danger' ? 'danger' : 'primary'}
              busy={busy}
              disabled={busy}
              onKeyDown={onKeyDown}
              onClick={() => void confirm()}
            >
              {busy ? 'Working' : confirmLabel}
            </Button>
            <Button size={size} variant="quiet" disabled={busy} onKeyDown={onKeyDown} onClick={() => toggle(false)}>
              Cancel
            </Button>
          </span>
        </span>
      ) : (
        <Button size={size} variant={variant} aria-label={triggerLabel} disabled={disabled} onClick={() => toggle(true)}>
          {trigger}
        </Button>
      )}
    </span>
  );
}
