import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/shell/app-shell';
import { AuthProvider, useAuth } from '@/features/auth/auth-context';
import { AnomaliesPage } from '@/pages/anomalies';
import { ApiKeysPage } from '@/pages/api-keys';
import { LoginPage } from '@/pages/login';
import { LogsPage } from '@/pages/logs';
import { OverviewPage } from '@/pages/overview';
import { RoutesPage } from '@/pages/routes';
import { TrafficPage } from '@/pages/traffic';
import { useTheme } from '@/components/ui/theme-toggle';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The dashboard polls; refetching on every window focus on top of that is just noise.
      refetchOnWindowFocus: false,
      staleTime: 5_000,
      retry: (failureCount, error) =>
        // A 401 is terminal: the session is gone and retrying cannot fix it.
        failureCount < 2 && !(error instanceof Error && error.name === 'ApiError' && (error as { status?: number }).status === 401),
    },
  },
});

function Gate() {
  const { admin, ready } = useAuth();

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <span className="sr-only">Restoring session</span>
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-brand-600 dark:border-zinc-700 dark:border-t-brand-400" />
      </div>
    );
  }
  if (!admin) return <LoginPage />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="traffic" element={<TrafficPage />} />
        <Route path="anomalies" element={<AnomaliesPage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="routes" element={<RoutesPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  // Applies the stored theme before anything renders below.
  useTheme();
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
