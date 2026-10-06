import type { ReactNode } from 'react';
import { isApiError } from '../../api/http';
import { ButtonLink, Card, CorrelationId, Notice } from '../../components';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import s from './applications.module.css';

/**
 * A warning for one ProblemDetail the screen handles itself (conflict, forbidden, unprocessable),
 * with the correlation id and audit link that ErrorNotice would show.
 */
export function ProblemNotice({ error, title, children, actions }: {
  error: unknown;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const cid = isApiError(error) ? error.correlationId : null;
  const detail = isApiError(error) ? error.detail : '';
  return (
    <Notice
      tone="warning"
      title={title}
      actions={(actions || cid) && <>{actions}{cid && <CorrelationId id={cid} />}</>}
    >
      {children ?? (detail && <p>{detail}</p>)}
    </Notice>
  );
}

/** The API answers 404 for both "no such application" and "no access", so the page says both. */
export function ApplicationNotFound() {
  useDocumentTitle('Application not found');
  return (
    <Card>
      <div className={s.notFound}>
        <h1 className={s.h1}>Application not found</h1>
        <p className={s.muted}>This application does not exist, or you do not have access to it.</p>
        <div>
          <ButtonLink to="/applications">Back to applications</ButtonLink>
        </div>
      </div>
    </Card>
  );
}

/** Small notice for a card whose endpoint the live backend does not have yet (hybrid mode, 501). */
export function NotBuiltNotice({ what, endpoint, children }: { what: string; endpoint: string; children?: ReactNode }) {
  return (
    <Notice tone="info" title={`${what} is not available yet`}>
      <p>
        It needs <code>{endpoint}</code>, which the backend does not have yet.
      </p>
      {children}
    </Notice>
  );
}
