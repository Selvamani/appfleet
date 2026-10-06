import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { startSession } from '../../api/agent';
import { listCatalogue } from '../../api/control';
import { isApiError } from '../../api/http';
import { qk } from '../../api/keys';
import type { CatalogueImage } from '../../api/types';
import { usePermissions } from '../../auth/usePermissions';
import { Button, Card, Columns, ErrorNotice, Loading, Mono, Muted, Notice, SearchField } from '../../components';
import { matchesQuery, startTimeLabel } from './sessionView';
import s from './Sessions.module.css';

type StartOutcome =
  | { kind: 'started'; image: CatalogueImage }
  | { kind: 'failed'; image: CatalogueImage; error: unknown };

/**
 * Tool images to start a session from (planned GET /api/v1/catalogue/images). The filter lives in the
 * URL (?q=), so a filtered catalogue can be shared. Starting adds a STARTING row to Your sessions.
 */
export function CatalogueGrid() {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const catalogue = useQuery({ queryKey: qk.catalogue(), queryFn: listCatalogue, staleTime: 10 * 60_000 });

  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [outcome, setOutcome] = useState<StartOutcome | null>(null);
  const start = useMutation({
    mutationFn: (image: CatalogueImage) => startSession(image.id),
    onMutate: image => {
      setOutcome(null);
      setPendingIds(ids => new Set(ids).add(image.id));
    },
    // Wait for the list, so the new STARTING row is there when the confirmation is announced.
    onSuccess: async (_started, image) => {
      void qc.invalidateQueries({ queryKey: qk.dashboardOverview() });
      await qc.invalidateQueries({ queryKey: qk.sessions() });
      setOutcome({ kind: 'started', image });
    },
    onError: (error, image) => {
      setOutcome({ kind: 'failed', image, error });
      // A conflict means Your sessions is out of date (for example a session started in another tab).
      if (isApiError(error) && error.type === 'conflict') void qc.invalidateQueries({ queryKey: qk.sessions() });
    },
    onSettled: (_data, _error, image) => {
      setPendingIds(ids => {
        const next = new Set(ids);
        next.delete(image.id);
        return next;
      });
    },
  });

  const mayStart = can('session:use');
  const notBuilt = isApiError(catalogue.error) && catalogue.error.type === 'not-implemented';
  const images = (catalogue.data ?? []).filter(image => matchesQuery(image, q));

  return (
    <Card
      title="Catalogue"
      titleId="catalogue-title"
      aside={
        <SearchField
          label="Search the catalogue"
          placeholder="Search tools"
          value={q}
          onChange={e => setParams(e.target.value ? { q: e.target.value } : {}, { replace: true })}
        />
      }
    >
      <div className={s.catalogue}>
        {outcome?.kind === 'started' && (
          <Notice tone="success" title={`Starting ${outcome.image.name}.`}>
            {startTimeLabel(outcome.image.warmPool)}. It is listed under Your sessions; Open appears when it is RUNNING.
          </Notice>
        )}
        {outcome?.kind === 'failed' && (
          <ErrorNotice error={outcome.error} context={`Could not start ${outcome.image.name}.`} onRetry={() => start.mutate(outcome.image)} />
        )}
        {!mayStart && <Muted as="p">Starting a tool session needs a role on a team.</Muted>}

        {catalogue.isPending && <Loading label="Loading the catalogue" />}
        {notBuilt && (
          <Notice tone="info" title="The catalogue is not built yet">
            Listing tool images needs the control-api catalogue module.
          </Notice>
        )}
        {catalogue.isError && !notBuilt && (
          <ErrorNotice error={catalogue.error} context="Could not load the catalogue." onRetry={() => void catalogue.refetch()} />
        )}
        {catalogue.isSuccess && catalogue.data.length === 0 && <Muted as="p">No tools are published yet.</Muted>}
        {catalogue.isSuccess && catalogue.data.length > 0 && images.length === 0 && (
          <Muted as="p">No tools match &quot;{q}&quot;.</Muted>
        )}
        {images.length > 0 && (
          <Columns layout="three">
            {images.map(image => (
              <ToolCard
                key={image.id}
                image={image}
                mayStart={mayStart}
                starting={pendingIds.has(image.id)}
                onStart={() => start.mutate(image)}
              />
            ))}
          </Columns>
        )}
      </div>
    </Card>
  );
}

function ToolCard({ image, mayStart, starting, onStart }: {
  image: CatalogueImage;
  mayStart: boolean;
  starting: boolean;
  onStart: () => void;
}) {
  const headingId = `tool-${image.id}`;
  return (
    <article className={s.tool} aria-labelledby={headingId}>
      <h3 id={headingId} className={s.h3}>{image.name}</h3>
      <p><span className="sr-only">Version </span><Mono>{image.version}</Mono></p>
      <p className={s.meta}>Built on <Mono>{image.baseImage}</Mono></p>
      <p className={s.meta}>{startTimeLabel(image.warmPool)}</p>
      {mayStart && (
        <div className={s.toolAction}>
          <Button
            size="sm"
            variant="primary"
            aria-label={`${starting ? 'Starting' : 'Start'} ${image.name}`}
            busy={starting}
            disabled={starting}
            onClick={onStart}
          >
            {starting ? 'Starting' : 'Start'}
          </Button>
        </div>
      )}
    </article>
  );
}
