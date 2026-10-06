import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components';
import s from './Deployment.module.css';

/**
 * Roll back, with its reason when unavailable and an inline confirmation before the request.
 * Focus: opening the confirmation moves focus to it (its question is read first); Cancel returns
 * focus to Roll back. After Confirm, the page moves focus to the outcome notice.
 */
export function RollbackControl({ question, blockedReason, onConfirm }: {
  /** "Roll back billing-api 2.4.0 in staging?" */
  question: string;
  /** Visible reason when Roll back is unavailable; null when it is allowed. */
  blockedReason: string | null;
  /** Sends the request; settles when the request has an answer. */
  onConfirm: () => Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  // Button does not take a ref, so focus goes back through its wrapper.
  const triggerWrapRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);
  const reasonId = useId();
  const questionId = useId();

  useEffect(() => {
    if (confirming) {
      confirmRef.current?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      triggerWrapRef.current?.querySelector('button')?.focus();
    }
  }, [confirming]);

  // The state can change under an open confirmation (polling); close it when Roll back is no longer allowed.
  if (confirming && !sending && blockedReason !== null) setConfirming(false);

  if (confirming) {
    return (
      <div ref={confirmRef} className={s.confirm} role="group" aria-labelledby={questionId} tabIndex={-1}>
        <p id={questionId} className={s.question}>{question}</p>
        <div className={s.confirmActions}>
          <Button
            variant="danger"
            busy={sending}
            disabled={sending}
            onClick={() => {
              setSending(true);
              void onConfirm().finally(() => {
                setSending(false);
                setConfirming(false);
              });
            }}
          >
            {sending ? 'Requesting rollback' : 'Confirm rollback'}
          </Button>
          <Button
            disabled={sending}
            onClick={() => {
              returnFocus.current = true;
              setConfirming(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div ref={triggerWrapRef} className={s.rollback}>
      <Button
        disabled={blockedReason !== null}
        aria-describedby={blockedReason ? reasonId : undefined}
        onClick={() => setConfirming(true)}
      >
        Roll back
      </Button>
      {blockedReason && <span id={reasonId} className={s.reason}>{blockedReason}</span>}
    </div>
  );
}
