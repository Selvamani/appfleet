import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { deactivateUser, getUser } from '../../api/identity';
import { qk } from '../../api/keys';
import { usePermissions } from '../../auth/usePermissions';
import { Card, Columns, DetailList, ErrorNotice, Loading, Mono, Muted, Notice, Stack, StatusChip } from '../../components';
import { formatWhen } from '../../lib/format';
import { InlineConfirm } from '../../components';
import { useApplyUser } from './accessQueries';
import { GrantsCard } from './GrantsCard';
import s from './AccessPage.module.css';

/**
 * One user: status, sign-in facts, deactivate, and their grants. Mount with key={userId} so notices and
 * form state never carry over from the previous user.
 */
export function UserDetail({ userId, focusOnLoad, onFocused }: {
  userId: string;
  /** Move focus to the user's heading once it shows, after a pick in the list. */
  focusOnLoad: boolean;
  onFocused: () => void;
}) {
  const { me } = usePermissions();
  const applyUser = useApplyUser();
  const user = useQuery({ queryKey: qk.user(userId), queryFn: () => getUser(userId) });
  const [deactivatedNow, setDeactivatedNow] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const deactivate = useMutation({
    mutationFn: () => deactivateUser(userId),
    onSuccess: updated => {
      setDeactivatedNow(true);
      return applyUser(updated);
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

  return (
    <Columns layout="pair" ratio="minmax(0, 0.85fr) minmax(0, 1.4fr)">
      <Card>
        <Stack>
          <div className={s.detailHead}>
            <h2 className={s.detailTitle} id="user-title" ref={headingRef} tabIndex={-1}>
              {u.username}
              {isDeactivated ? <StatusChip status="DEACTIVATED" label="Deactivated" /> : <StatusChip status="ACTIVE" label="Active" />}
            </h2>
            {!isMe && (
              <InlineConfirm
                trigger="Deactivate"
                triggerLabel={`Deactivate ${u.username}`}
                prompt={`Deactivate ${u.username}?`}
                confirmLabel="Deactivate"
                variant="danger"
                disabled={isDeactivated}
                onConfirm={() => deactivate.mutateAsync()}
              />
            )}
          </div>
          {deactivatedNow && (
            <Notice tone="success">
              {u.username} is deactivated. Their tokens stop working within 5 minutes, and they cannot sign in again.
            </Notice>
          )}
          {deactivate.isError && <ErrorNotice error={deactivate.error} context={`Could not deactivate ${u.username}.`} />}
          <DetailList
            items={[
              ['Last sign-in', u.lastSignIn ? <>{formatWhen(u.lastSignIn.at)} UTC from <Mono>{u.lastSignIn.ip}</Mono></> : 'Never signed in'],
              ['Sign-in security', u.securityNote],
              ['Failed sign-ins', u.failedSignIns],
            ]}
          />
          {isMe && <Muted as="p">This is you. You cannot deactivate your own account.</Muted>}
          <Muted as="p">Users are deactivated, never deleted, so their audit history stays complete.</Muted>
        </Stack>
      </Card>
      <GrantsCard user={u} />
    </Columns>
  );
}
