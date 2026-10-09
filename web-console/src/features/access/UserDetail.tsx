import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { deactivateUser, getUser, listLoginAudit } from '../../api/identity';
import { qk } from '../../api/keys';
import type { Grant } from '../../api/types';
import { usePermissions } from '../../auth/usePermissions';
import { Card, Columns, DetailList, ErrorNotice, InlineConfirm, Loading, Mono, Muted, Notice, Stack, StatusChip } from '../../components';
import { formatWhen } from '../../lib/format';
import { who } from './accessQueries';
import { GrantsCard } from './GrantsCard';
import s from './AccessPage.module.css';

/**
 * One user: status, what the sign-in audit says about them, deactivate, and their grants. Mount with key={userId} so
 * notices and form state never carry over from the previous user.
 */
export function UserDetail({ userId, grants, focusOnLoad, onFocused }: {
  userId: string;
  grants: Grant[];
  /** Move focus to the user's heading once it shows, after a pick in the list. */
  focusOnLoad: boolean;
  onFocused: () => void;
}) {
  const { me } = usePermissions();
  const user = useQuery({ queryKey: qk.user(userId), queryFn: () => getUser(userId) });
  // The newest sign-in attempts (platform administrators only). Counted here, not stored: it is the audit's own answer.
  const recent = useQuery({ queryKey: [...qk.loginAudit(), 'recent'], queryFn: () => listLoginAudit(undefined, 200), staleTime: 30_000 });
  const [deactivatedNow, setDeactivatedNow] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const deactivate = useMutation({
    mutationFn: () => deactivateUser(userId),
    onSuccess: () => {
      setDeactivatedNow(true);
      void user.refetch();
    },
  });

  const loaded = user.isSuccess;
  useEffect(() => {
    if (!focusOnLoad || !loaded) return;
    // After the shell's own focus move on navigation, so the heading wins (and scrolls into view on phones).
    const id = window.setTimeout(() => {
      headingRef.current?.focus();
      onFocused();
    }, 0);
    return () => window.clearTimeout(id);
  }, [focusOnLoad, loaded, onFocused]);

  if (user.isPending) return <Card><Loading label="Loading the user" /></Card>;
  if (user.isError) {
    return <Card><ErrorNotice error={user.error} context="Could not load this user." onRetry={() => void user.refetch()} /></Card>;
  }

  const u = user.data;
  const isDeactivated = u.status === 'DEACTIVATED';
  const isMe = u.id === me?.id;
  const rows = recent.data?.items.filter(r => r.userId === u.id) ?? [];
  const lastSignIn = rows.find(r => r.event === 'LOGIN' && r.outcome === 'SUCCESS');
  const failures = rows.filter(r => r.event === 'LOGIN' && r.outcome !== 'SUCCESS').length;

  return (
    <Columns layout="pair" ratio="minmax(0, 0.85fr) minmax(0, 1.4fr)">
      <Card>
        <Stack>
          <div className={s.detailHead}>
            <h2 className={s.detailTitle} id="user-title" ref={headingRef} tabIndex={-1}>
              {who(u)}
              {isDeactivated ? <StatusChip status="DEACTIVATED" label="Deactivated" /> : <StatusChip status="ACTIVE" label="Active" />}
            </h2>
            {!isMe && (
              <InlineConfirm
                trigger="Deactivate"
                triggerLabel={`Deactivate ${who(u)}`}
                prompt={`Deactivate ${who(u)}?`}
                confirmLabel="Deactivate"
                variant="danger"
                disabled={isDeactivated}
                onConfirm={() => deactivate.mutateAsync()}
              />
            )}
          </div>
          {deactivatedNow && (
            <Notice tone="success">
              {who(u)} is deactivated. Every session of theirs ended at once, and they cannot sign in again.
            </Notice>
          )}
          {deactivate.isError && <ErrorNotice error={deactivate.error} context={`Could not deactivate ${who(u)}.`} />}
          <DetailList
            items={[
              ['Email', <Mono key="email">{u.email}</Mono>],
              ['Created', formatWhen(u.createdAt)],
              ...(u.deactivatedAt ? [['Deactivated', formatWhen(u.deactivatedAt)] as [string, string]] : []),
              ['Last sign-in', recent.isSuccess ? (lastSignIn ? <>{formatWhen(lastSignIn.occurredAt)} UTC from <Mono>{lastSignIn.ip ?? 'unknown'}</Mono></> : 'Not in the newest 200 audit rows') : '...'],
              ['Failed sign-ins', recent.isSuccess ? `${failures} in the newest 200 audit rows` : '...'],
            ]}
          />
          {isMe && <Muted as="p">This is you. You cannot deactivate your own account.</Muted>}
          <Muted as="p">Users are deactivated, never deleted, so their audit history stays complete.</Muted>
        </Stack>
      </Card>
      <GrantsCard user={u} grants={grants} />
    </Columns>
  );
}
