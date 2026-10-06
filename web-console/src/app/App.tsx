import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { PermissionsProvider } from '../auth/PermissionsProvider';
import { createQueryClient } from './queryClient';
import { routes } from './routes';

const router = createBrowserRouter(routes);

export function App({ client }: { client?: QueryClient }) {
  const [queryClient] = useState(() => client ?? createQueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <PermissionsProvider>
        <RouterProvider router={router} />
      </PermissionsProvider>
    </QueryClientProvider>
  );
}
