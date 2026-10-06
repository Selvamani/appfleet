import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/http';
import { PermissionsContext, type PermissionsValue } from '../auth/PermissionsProvider';
import { DataTable, ErrorNotice, Freshness, InlineConfirm, StatusChip, Stepper } from './index';

function withRouter(ui: React.ReactNode, perms?: Partial<PermissionsValue>) {
  const value: PermissionsValue = { me: undefined, isLoading: false, error: null, can: () => false, teams: [], ...perms };
  return render(
    <PermissionsContext.Provider value={value}>
      <MemoryRouter>{ui}</MemoryRouter>
    </PermissionsContext.Provider>,
  );
}

describe('StatusChip', () => {
  it('always prints the status word, so colour is never the only signal', () => {
    render(<StatusChip status="DEGRADED" />);
    expect(screen.getByText('DEGRADED')).toHaveClass('chip', 'attention');
  });

  it('can show a friendlier label with the same tone', () => {
    render(<StatusChip status="STALE" label="Stale heartbeat" />);
    expect(screen.getByText('Stale heartbeat')).toHaveClass('attention');
  });
});

describe('DataTable', () => {
  const rows = [{ id: 'a', name: 'billing-api' }, { id: 'b', name: 'ledger-worker' }];
  const columns = [{ key: 'name', header: 'Name', width: '1fr', render: (r: { name: string }) => r.name }];

  it('exposes table semantics', () => {
    render(<DataTable label="Apps" columns={columns} rows={rows} rowKey={r => r.id} />);
    const table = screen.getByRole('table', { name: 'Apps' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
  });

  it('turns rows into pressed buttons when selectable', async () => {
    const onSelect = vi.fn();
    render(<DataTable label="Apps" columns={columns} rows={rows} rowKey={r => r.id} onSelect={onSelect} selectedKey="b" />);
    const list = screen.getByRole('list', { name: 'Apps' });
    expect(within(list).getByRole('button', { name: 'ledger-worker' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(list).getByRole('button', { name: 'billing-api' }));
    expect(onSelect).toHaveBeenCalledWith(rows[0]);
  });

  it('says so when empty', () => {
    render(<DataTable label="Apps" columns={columns} rows={[] as typeof rows} rowKey={r => r.id} emptyText="No applications." />);
    expect(screen.getByText('No applications.')).toBeInTheDocument();
  });
});

describe('Stepper', () => {
  it('marks the current step for assistive technology', () => {
    render(<Stepper label="Progress" steps={[{ label: 'PENDING', state: 'done' }, { label: 'DEPLOYING', state: 'current' }, { label: 'HEALTHY', state: 'todo' }]} />);
    const current = screen.getByText('DEPLOYING').closest('li');
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(within(current!).getByText('Current')).toBeInTheDocument();
  });
});

describe('Freshness', () => {
  it('shows asOf and how far behind it is', () => {
    const now = Date.parse('2026-10-02T10:00:05Z');
    render(<Freshness asOf="2026-10-02T10:00:02Z" now={now} />);
    expect(screen.getByText('asOf 10:00:02 UTC, 3 s behind')).toBeInTheDocument();
  });

  it('says Updating until the read model has caught up with your write', () => {
    render(<Freshness asOf="2026-10-02T10:00:02Z" waitingFor="2026-10-02T10:00:04Z" />);
    expect(screen.getByText(/Updating/)).toBeInTheDocument();
  });
});

describe('ErrorNotice', () => {
  const conflict = new ApiError({ status: 409, type: 'conflict', title: 'Conflict', detail: 'Already active.', correlationId: 'c-42' });

  it('uses the treatment for the ProblemDetail type and shows the correlation id', () => {
    withRouter(<ErrorNotice error={conflict} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Conflicts with the current state');
    expect(alert).toHaveTextContent('Already active.');
    expect(alert).toHaveTextContent('c-42');
  });

  it('links to the audit trail only for callers with audit:read', () => {
    const first = withRouter(<ErrorNotice error={conflict} />, { can: () => false });
    expect(screen.queryByRole('link', { name: 'Find in audit trail' })).not.toBeInTheDocument();
    first.unmount();
    withRouter(<ErrorNotice error={conflict} />, { can: p => p === 'audit:read' });
    expect(screen.getByRole('link', { name: 'Find in audit trail' })).toHaveAttribute('href', '/audit?cid=c-42');
  });

  it('offers retry only when retrying can help', () => {
    const onRetry = vi.fn();
    const first = withRouter(<ErrorNotice error={conflict} onRetry={onRetry} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    first.unmount();
    const down = new ApiError({ status: 503, type: 'service-unavailable', title: 'Service unavailable', detail: 'Redis is down.', correlationId: 'c-43' });
    withRouter(<ErrorNotice error={down} onRetry={onRetry} />);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('InlineConfirm', () => {
  it('asks before acting and returns focus on Cancel', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<InlineConfirm trigger="Drain" triggerLabel="Drain dev-node-01" prompt="Drain dev-node-01?" confirmLabel="Drain node" onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Drain dev-node-01' }));
    expect(screen.getByRole('button', { name: 'Drain node' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Drain dev-node-01' })).toHaveFocus();
  });

  it('acts once confirmed', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<InlineConfirm trigger="Drain" prompt="Drain it?" confirmLabel="Drain node" onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Drain' }));
    await user.click(screen.getByRole('button', { name: 'Drain node' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
