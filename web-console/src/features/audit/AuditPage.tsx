import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { qk } from '../../api/keys';
import { listAuditEvents } from '../../api/query';
import type { AuditEventRow, AuditFilter } from '../../api/types';
import {
  Button, Card, Columns, DataTable, EmptyState, ErrorNotice, Freshness, LoadMore, Loading, PageHeader, Segmented, StatusChip, type Column,
} from '../../components';
import { useCursorList } from '../../hooks/useCursorList';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { formatWhen } from '../../lib/format';
import { AuditEventDetail } from './AuditEventDetail';
import { AuditFilters } from './AuditFilters';
import { SignIns } from './SignIns';
import s from './audit.module.css';

type View = 'actions' | 'signins';

const VIEW_OPTIONS: Array<{ value: View; label: string }> = [
  { value: 'actions', label: 'Actions' },
  { value: 'signins', label: 'Sign-ins' },
];

/** Filter field and the search parameter that carries it, so filtered views are shareable links. */
const FILTER_PARAMS: Array<[keyof AuditFilter, string]> = [
  ['actor', 'actor'],
  ['action', 'action'],
  ['object', 'object'],
  ['correlationId', 'cid'],
];

function filterFrom(params: URLSearchParams): AuditFilter {
  const filter: AuditFilter = {};
  for (const [field, param] of FILTER_PARAMS) {
    const value = params.get(param)?.trim();
    if (value) filter[field] = value;
  }
  return filter;
}

/** The two-column layout stacks below this width (tokens.css), which puts the detail under the list. */
const STACKED = '(max-width: 860px)';

const columns: Column<AuditEventRow>[] = [
  { key: 'time', header: 'Time (UTC)', width: 'minmax(120px, 0.8fr)', render: r => <span className={s.time}>{formatWhen(r.at)}</span> },
  { key: 'actor', header: 'Actor', width: 'minmax(80px, 0.8fr)', render: r => r.actor },
  { key: 'action', header: 'Action', width: 'minmax(150px, 1.4fr)', render: r => <span className={s.action}>{r.action}</span> },
  { key: 'object', header: 'Object', width: 'minmax(140px, 1.6fr)', render: r => <span className={s.object}>{r.object}</span> },
  { key: 'outcome', header: 'Outcome', width: 'minmax(96px, 0.8fr)', render: r => <StatusChip status={r.outcome} /> },
];

export function AuditPage() {
  useDocumentTitle('Audit trail');
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'signins' ? 'signins' : 'actions';
  const filter = filterFrom(params);
  const filtered = Object.keys(filter).length > 0;

  const events = useCursorList(qk.audit(filter), cursor => listAuditEvents(filter, cursor), { enabled: view === 'actions' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  // An explicit pick wins; otherwise a ?cid= link (from any error notice) opens its first matching event.
  const cid = filter.correlationId?.toLowerCase();
  const selected = events.items.find(r => r.id === selectedId)
    ?? (cid ? events.items.find(r => r.correlationId.toLowerCase() === cid) : undefined);

  const setFilter = (next: AuditFilter) => {
    setParams(prev => {
      const out = new URLSearchParams(prev);
      for (const [field, param] of FILTER_PARAMS) {
        const value = next[field];
        if (value) out.set(param, value);
        else out.delete(param);
      }
      return out;
    });
  };

  const setView = (next: View) => {
    setParams(prev => {
      const out = new URLSearchParams(prev);
      if (next === 'signins') out.set('view', 'signins');
      else out.delete('view');
      return out;
    });
  };

  const select = (row: AuditEventRow) => {
    setSelectedId(row.id);
    // Stacked layout: the detail sits under a long list, so bring it into view.
    if (window.matchMedia?.(STACKED).matches) detailRef.current?.scrollIntoView({ block: 'start' });
  };

  return (
    <>
      <PageHeader
        title="Audit trail"
        subtitle="Who did what, when, to what. Append-only."
        actions={view === 'actions' && <Freshness asOf={events.firstPage?.asOf} />}
      />
      <Segmented label="Audit view" options={VIEW_OPTIONS} value={view} onChange={setView} />

      {view === 'signins' && <SignIns />}

      {view === 'actions' && (
        <>
          <AuditFilters key={JSON.stringify(filter)} applied={filter} onApply={setFilter} onClear={() => setFilter({})} />
          <Columns layout="two">
            <Card title="Events" titleId="audit-events-title" aside="Newest first, times in UTC">
              {events.isPending && <Loading label="Loading audit events" />}
              {events.isError && <ErrorNotice error={events.error} context="Could not load audit events." onRetry={() => void events.refetch()} />}
              {events.isSuccess && events.items.length === 0 && (
                filtered ? (
                  <EmptyState title="No events match these filters" action={<Button size="sm" onClick={() => setFilter({})}>Clear filters</Button>}>
                    Check the spelling, or remove a filter to widen the search.
                  </EmptyState>
                ) : (
                  <EmptyState title="No events recorded yet">Every write and every sign-in attempt is recorded here.</EmptyState>
                )
              )}
              {events.isSuccess && events.items.length > 0 && (
                <>
                  <DataTable
                    label="Audit events"
                    columns={columns}
                    rows={events.items}
                    rowKey={r => r.id}
                    minWidth={660}
                    onSelect={select}
                    selectedKey={selected?.id}
                  />
                  <LoadMore hasMore={events.hasNextPage} loading={events.isFetchingNextPage} onLoad={() => void events.fetchNextPage()} />
                </>
              )}
            </Card>
            <AuditEventDetail ref={detailRef} event={selected} />
          </Columns>
        </>
      )}
    </>
  );
}
