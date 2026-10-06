import { PageHeader } from '../../components';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { CatalogueGrid } from './CatalogueGrid';
import { SessionList } from './SessionList';

/**
 * Tool sessions (preview screen 5): Catalogue, Start, STARTING, RUNNING, End. node-agent (S5) does not
 * exist yet, so sessions stay simulated in both modes; the catalogue may answer 501 in hybrid mode.
 */
export function SessionsPage() {
  useDocumentTitle('Tool sessions');
  return (
    <>
      <PageHeader title="Tool sessions" subtitle="Run heavy tools in your browser. Nothing installs on your laptop." />
      <SessionList />
      <CatalogueGrid />
    </>
  );
}
