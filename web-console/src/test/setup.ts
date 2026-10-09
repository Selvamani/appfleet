import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { configureAuth } from '../api/http';
import { endSession } from '../auth/session';
import { resetDb } from '../mocks/db';
import { setDevRole } from '../mocks/devRole';
import { server } from './server';

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  // jsdom does not implement scrolling; the shell scrolls to the top on navigation.
  window.scrollTo = () => {};
});
beforeEach(() => {
  resetDb();
  setDevRole('DEPLOYER');
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});
afterEach(() => {
  cleanup();
  endSession();
  configureAuth(undefined);
  server.resetHandlers();
});
afterAll(() => server.close());
