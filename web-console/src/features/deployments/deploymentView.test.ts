import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/http';
import type { DeploymentResponse, TimelineEvent } from '../../api/types';
import { liveLabel, progressSteps, rollbackBlockedReason, shortChecksum, timelinePollInterval } from './deploymentView';

const states = (status: Parameters<typeof progressSteps>[0], events?: TimelineEvent[]) =>
  progressSteps(status, events).map(s => s.state);

const ev = (status: TimelineEvent['status']): TimelineEvent => ({ at: '2026-10-02T10:00:00Z', text: 'x', status });

describe('progressSteps', () => {
  it('marks the current step on the happy path', () => {
    expect(states('PENDING')).toEqual(['current', 'todo', 'todo', 'todo']);
    expect(states('DEPLOYING')).toEqual(['done', 'done', 'current', 'todo']);
    expect(states('HEALTHY')).toEqual(['done', 'done', 'done', 'current']);
  });

  it('marks every step done for DEGRADED and ROLLED_BACK', () => {
    expect(states('DEGRADED')).toEqual(['done', 'done', 'done', 'done']);
    expect(states('ROLLED_BACK')).toEqual(['done', 'done', 'done', 'done']);
  });

  it('marks where a FAILED deployment stopped', () => {
    expect(states('FAILED', [ev('PENDING'), ev('VALIDATING'), ev('DEPLOYING'), ev('FAILED')])).toEqual(['done', 'done', 'failed', 'todo']);
    expect(states('FAILED', [ev('PENDING'), ev('VALIDATING'), ev('FAILED')])).toEqual(['done', 'failed', 'todo', 'todo']);
    // without a timeline, assume it got as far as DEPLOYING
    expect(states('FAILED')).toEqual(['done', 'done', 'failed', 'todo']);
  });
});

describe('rollbackBlockedReason', () => {
  it('allows HEALTHY and DEGRADED only, and only once', () => {
    expect(rollbackBlockedReason('HEALTHY', false)).toBeNull();
    expect(rollbackBlockedReason('DEGRADED', false)).toBeNull();
    expect(rollbackBlockedReason('HEALTHY', true)).toBe('A rollback is already requested.');
    expect(rollbackBlockedReason('DEPLOYING', false)).toBe('Available once the deployment is HEALTHY or DEGRADED.');
    expect(rollbackBlockedReason('FAILED', false)).toBe('Not available from a final state.');
    expect(rollbackBlockedReason('ROLLED_BACK', false)).toBe('Not available from a final state.');
  });
});

describe('liveLabel', () => {
  it('follows the polling policy', () => {
    expect(liveLabel('VALIDATING', false)).toBe('Live: updates every 2 s');
    expect(liveLabel('HEALTHY', false)).toBe('Settled: checks every 30 s');
    expect(liveLabel('HEALTHY', true)).toBe('Live: updates every 2 s');
    expect(liveLabel('FAILED', false)).toBe('Final state');
  });
});

describe('timelinePollInterval', () => {
  const dep = (status: DeploymentResponse['status'], updatedAt: string): DeploymentResponse => ({
    id: 'd', applicationId: 'a', releaseId: 'r', environment: 'prod', status, createdAt: updatedAt, updatedAt,
  });

  it('keeps polling a final deployment until the projection has caught up', () => {
    expect(timelinePollInterval('2026-10-02T10:00:00Z', null, dep('FAILED', '2026-10-02T10:00:01Z'), false)).toBe(2000);
    expect(timelinePollInterval('2026-10-02T10:00:02Z', null, dep('FAILED', '2026-10-02T10:00:01Z'), false)).toBe(false);
  });

  it('stops when query-service is not built', () => {
    const notBuilt = new ApiError({ status: 501, type: 'not-implemented', title: 'Not implemented', detail: '', correlationId: 'c' });
    expect(timelinePollInterval(undefined, notBuilt, dep('DEPLOYING', '2026-10-02T10:00:01Z'), false)).toBe(false);
  });
});

describe('shortChecksum', () => {
  it('keeps the algorithm, the start and the end', () => {
    expect(shortChecksum(`sha256:${'a'.repeat(60)}e41a`)).toBe('sha256:aaaaaa…e41a');
  });
});
