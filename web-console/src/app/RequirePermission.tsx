import type { ReactNode } from 'react';
import type { Permission } from '../auth/permissions';
import { usePermissions } from '../auth/usePermissions';
import { Loading } from '../components';
import { NotFoundPage } from './NotFoundPage';

/**
 * Hides a screen from callers without the permission, by showing NotFoundPage. Convenience only:
 * the API enforces the same rule.
 */
export function RequirePermission({ permission, teamId, children }: { permission: Permission; teamId?: string; children: ReactNode }) {
  const { me, isLoading, can } = usePermissions();
  if (isLoading && !me) return <Loading label="Checking access" />;
  return can(permission, teamId) ? <>{children}</> : <NotFoundPage />;
}
