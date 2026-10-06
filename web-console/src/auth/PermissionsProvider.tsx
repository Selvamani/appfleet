import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useMemo, type ReactNode } from 'react';
import { getMe } from '../api/identity';
import { qk } from '../api/keys';
import type { Me } from '../api/types';
import { can as canFor, visibleTeams, type Permission } from './permissions';

export interface PermissionsValue {
  me: Me | undefined;
  isLoading: boolean;
  error: unknown;
  can: (permission: Permission, teamId?: string) => boolean;
  teams: string[] | 'all';
}

export const PermissionsContext = createContext<PermissionsValue | null>(null);

export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { data: me, isLoading, error } = useQuery({ queryKey: qk.me(), queryFn: getMe, staleTime: 60_000 });
  const can = useCallback((permission: Permission, teamId?: string) => canFor(me, permission, teamId), [me]);
  const value = useMemo<PermissionsValue>(
    () => ({ me, isLoading, error, can, teams: visibleTeams(me) }),
    [me, isLoading, error, can],
  );
  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}
