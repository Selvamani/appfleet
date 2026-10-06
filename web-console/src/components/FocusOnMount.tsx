import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Wraps an outcome (usually a Notice) that replaces the control the user just pressed, for example a
 * table row that disappears after Revoke. Taking focus here keeps keyboard and screen-reader users in
 * place instead of dropping them at the top of the document.
 */
export function FocusOnMount({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (enabled) ref.current?.focus();
  }, [enabled]);
  return <div ref={ref} tabIndex={-1}>{children}</div>;
}
