import { ButtonLink, Card } from '../components';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

/**
 * Shown for unknown addresses and for screens the caller may not open. Same page for both, so the
 * console never confirms that something exists (the API answers 404 for the same reason).
 */
export function NotFoundPage() {
  useDocumentTitle('Page not found');
  return (
    <Card>
      <h1 style={{ fontSize: '1.72rem', fontWeight: 600 }}>Page not found</h1>
      <p style={{ margin: '0.4rem 0 1rem', color: 'var(--muted)' }}>This page does not exist, or you do not have access to it.</p>
      <ButtonLink to="/">Back to the dashboard</ButtonLink>
    </Card>
  );
}
