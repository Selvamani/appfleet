import { useContext } from 'react';
import { PermissionsContext, type PermissionsValue } from './PermissionsProvider';

/** Who is signed in and what they may do. Wrap the app in PermissionsProvider. */
export function usePermissions(): PermissionsValue {
  const value = useContext(PermissionsContext);
  if (!value) throw new Error('usePermissions must be used inside PermissionsProvider');
  return value;
}
