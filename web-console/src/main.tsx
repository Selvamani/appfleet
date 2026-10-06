import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/tokens.css';
import './styles/global.css';

/**
 * MSW runs in both modes: in mock mode it answers everything; in hybrid mode it passes built
 * control-api calls through to the dev proxy and simulates the services that do not exist yet.
 */
async function startMocks() {
  const { worker } = await import('./mocks/browser');
  await worker.start({
    onUnhandledFrame: 'bypass',
    quiet: true,
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
  });
}

startMocks().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
