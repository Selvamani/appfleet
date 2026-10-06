import { describe, expect, it } from 'vitest';
import { serviceFor } from './proxy.config';

describe('dev proxy routing', () => {
  it('sends query-service paths that sit under control-api prefixes to query-service', () => {
    expect(serviceFor('/api/v1/applications/0192f3a1-0000-7000-8000-000000000001/history')).toBe('query');
    expect(serviceFor('/api/v1/deployments/0192f3a1-0000-7000-8000-000000000001/timeline')).toBe('query');
  });

  it('keeps the rest of those prefixes on control-api', () => {
    expect(serviceFor('/api/v1/applications')).toBe('control');
    expect(serviceFor('/api/v1/applications/abc/releases')).toBe('control');
    expect(serviceFor('/api/v1/deployments/abc/tasks?cursor=x')).toBe('control');
    expect(serviceFor('/api/v1/tasks/abc')).toBe('control');
  });

  it('sends sign-in audit to identity-service and other audit reads to query-service', () => {
    expect(serviceFor('/api/v1/audit/logins')).toBe('identity');
    expect(serviceFor('/api/v1/audit?cid=c-1')).toBe('query');
  });

  it('routes the other services', () => {
    expect(serviceFor('/api/v1/users/me')).toBe('identity');
    expect(serviceFor('/api/v1/sessions')).toBe('agent');
    expect(serviceFor('/api/v1/dlq/abc/replay')).toBe('task');
    expect(serviceFor('/api/v1/dashboard/deployments')).toBe('query');
    expect(serviceFor('/unknown')).toBeUndefined();
  });
});
