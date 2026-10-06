import { setupServer } from 'msw/node';
import { handlers } from '../mocks/handlers';

/** The same handlers the browser uses, in Node for tests. */
export const server = setupServer(...handlers);
