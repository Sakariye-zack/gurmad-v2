import { QueryClient } from '@tanstack/react-query';

// The query/cache layer specified in Frontend_Architecture.md §2, replacing
// the current system's ad-hoc useState+useEffect+manual-refetch pattern
// repeated on every page (the direct cause of several "stale data after a
// mutation" bugs found across the T2.8 audit).
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
