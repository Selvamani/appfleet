import { useInfiniteQuery, type InfiniteData, type Query, type QueryKey } from '@tanstack/react-query';
import type { CursorPage } from '../api/types';

/**
 * Any ?cursor= list. Pages are fetched on demand with "Load older"; no page numbers, because the
 * backend paginates by keyset (plan §8.6). The page type can carry extra fields (for example asOf);
 * firstPage exposes them.
 */
export function useCursorList<P extends CursorPage<unknown>>(
  queryKey: QueryKey,
  fetchPage: (cursor: string | undefined) => Promise<P>,
  opts: {
    enabled?: boolean;
    /** A number, false, or a function of the query (for example to stop polling after an error). */
    refetchInterval?: number | false | ((query: Query<P, Error, InfiniteData<P, string | undefined>, QueryKey>) => number | false | undefined);
  } = {},
) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.nextCursor ?? undefined,
    enabled: opts.enabled,
    refetchInterval: opts.refetchInterval,
  });
  const pages = query.data?.pages ?? [];
  return {
    ...query,
    items: pages.flatMap(p => p.items) as Array<P['items'][number]>,
    firstPage: pages[0],
  };
}
