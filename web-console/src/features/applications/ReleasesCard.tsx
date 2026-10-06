import { Link } from 'react-router';
import { listReleases } from '../../api/control';
import { qk } from '../../api/keys';
import type { ReleaseResponse, WhatRunsWhere } from '../../api/types';
import {
  Button, ButtonLink, Card, DataTable, EmptyState, ErrorNotice, LoadMore, Loading, Mono, Muted, Notice, type Column,
} from '../../components';
import { useCursorList } from '../../hooks/useCursorList';
import { formatWhen } from '../../lib/format';
import { isFinal } from '../../lib/statusTone';
import { NotBuiltNotice } from './notices';
import { isNotBuilt, shortChecksum } from './shared';
import s from './applications.module.css';

/** The releases of one application, newest first, each with a link to deploy it. */
export function ReleasesCard({ applicationId, where, canDeploy, canRelease, registered, onRegisterRelease }: {
  applicationId: string;
  /** The read model's current state, for the "Running in" column; absent while loading or not built. */
  where: WhatRunsWhere | undefined;
  canDeploy: boolean;
  canRelease: boolean;
  /** The release the caller just registered, for the confirmation. */
  registered: ReleaseResponse | null;
  onRegisterRelease: () => void;
}) {
  const releases = useCursorList(qk.releases(applicationId), cursor => listReleases(applicationId, cursor));
  const deployHref = (releaseId: string) => `/applications/${applicationId}/deploy?release=${encodeURIComponent(releaseId)}`;

  const cells = where?.rows[0]?.cells ?? {};
  const runningIn = (version: string) =>
    (where?.environments ?? []).filter(env => {
      const c = cells[env];
      return c && c.releaseVersion === version && !isFinal(c.status);
    });

  const columns: Column<ReleaseResponse>[] = [
    { key: 'version', header: 'Version', width: 'minmax(80px, 0.6fr)', render: r => <strong><Mono>{r.version}</Mono></strong> },
    { key: 'artifact', header: 'Artifact', width: 'minmax(220px, 2.8fr)', render: r => <Mono>{r.artifactRef}</Mono> },
    {
      key: 'checksum', header: 'Checksum', width: 'minmax(140px, 1fr)',
      render: r => <Mono title={r.checksum}>{shortChecksum(r.checksum)}</Mono>,
    },
    { key: 'registered', header: 'Registered (UTC)', width: 'minmax(100px, 0.8fr)', render: r => formatWhen(r.createdAt) },
  ];
  if (where) {
    columns.push({
      key: 'running', header: 'Running in', width: 'minmax(90px, 0.8fr)',
      render: r => {
        const envs = runningIn(r.version);
        return envs.length ? envs.join(', ') : <Muted>Not running</Muted>;
      },
    });
  }
  if (canDeploy) {
    columns.push({
      key: 'deploy', header: <span className="sr-only">Actions</span>, width: 'minmax(60px, 0.4fr)',
      render: r => <Link to={deployHref(r.id)}>Deploy{' '}<span className="sr-only">{r.version}</span></Link>,
    });
  }

  return (
    <Card title="Releases" titleId="releases-title" aside="Releases cannot be changed once registered.">
      <div className={s.cardStack}>
        {registered && (
          <Notice
            tone="success"
            title={`Release ${registered.version} registered. It cannot be changed.`}
            actions={canDeploy && <ButtonLink size="sm" variant="primary" to={deployHref(registered.id)}>Deploy {registered.version}</ButtonLink>}
          >
            <p>Release id <Mono>{registered.id}</Mono></p>
          </Notice>
        )}
        {releases.isPending && <Loading label="Loading releases" />}
        {releases.isError && (isNotBuilt(releases.error)
          ? (
            <NotBuiltNotice what="The release list" endpoint="GET /api/v1/applications/{id}/releases">
              <p>Registering a release works. To deploy one, use its release id on the deploy page.</p>
            </NotBuiltNotice>
          )
          : <ErrorNotice error={releases.error} context="Could not load releases." onRetry={() => void releases.refetch()} />)}
        {releases.isSuccess && releases.items.length === 0 && (
          <EmptyState
            title="No releases yet"
            action={canRelease && <Button size="sm" onClick={onRegisterRelease}>Register release</Button>}
          >
            A release is one version of this application, with its artifact and checksum.
          </EmptyState>
        )}
        {releases.isSuccess && releases.items.length > 0 && (
          <div>
            <DataTable
              label="Releases"
              columns={columns}
              rows={releases.items}
              rowKey={r => r.id}
              minWidth={where ? 760 : 660}
            />
            <LoadMore
              hasMore={releases.hasNextPage}
              loading={releases.isFetchingNextPage}
              onLoad={() => void releases.fetchNextPage()}
              note="Newest first."
            />
          </div>
        )}
      </div>
    </Card>
  );
}
