import { isRouteErrorResponse, useRouteError } from 'react-router';
import { ButtonLink, ErrorNotice } from '../components';
import { NotFoundPage } from './NotFoundPage';

/** Errors thrown while loading a route (for example a chunk that failed to download). */
export function RouteError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  return (
    <div style={{ padding: 'var(--gutter)', display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '48rem' }}>
      <ErrorNotice error={error} context="This page failed to load." onRetry={() => window.location.reload()} retryLabel="Reload" />
      <ButtonLink to="/">Back to the dashboard</ButtonLink>
    </div>
  );
}
