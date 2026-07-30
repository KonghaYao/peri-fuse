import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "@/shared/components/layout";
import { TooltipProvider } from "@/shared/components/ui/tooltip";
import { hasActiveProject, useProjectContext } from "@/shared/store/project";

// Route-level code splitting: each page is its own chunk.
const DashboardPage = lazy(() =>
  import("@/features/dashboard/dashboard-page").then((m) => ({ default: m.DashboardPage })),
);
const TracesPage = lazy(() =>
  import("@/features/traces/traces-page").then((m) => ({ default: m.TracesPage })),
);
const TraceDetailPage = lazy(() =>
  import("@/features/traces/trace-detail-page").then((m) => ({ default: m.TraceDetailPage })),
);
const SessionsPage = lazy(() =>
  import("@/features/sessions/sessions-page").then((m) => ({ default: m.SessionsPage })),
);
const SessionDetailPage = lazy(() =>
  import("@/features/sessions/session-detail-page").then((m) => ({
    default: m.SessionDetailPage,
  })),
);
const UsersPage = lazy(() =>
  import("@/features/users/users-page").then((m) => ({ default: m.UsersPage })),
);
const ObservationsPage = lazy(() =>
  import("@/features/observations/observations-page").then((m) => ({
    default: m.ObservationsPage,
  })),
);
const ScoresPage = lazy(() =>
  import("@/features/scores/scores-page").then((m) => ({ default: m.ScoresPage })),
);
const SettingsPage = lazy(() =>
  import("@/features/settings/settings-page").then((m) => ({ default: m.SettingsPage })),
);
const OnboardingPage = lazy(() =>
  import("@/features/onboarding/onboarding-page").then((m) => ({ default: m.OnboardingPage })),
);

/**
 * Route-level suspense fallback: a page-shaped skeleton instead of a spinner.
 */
function PageFallback() {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-4">
        <div className="h-5 w-32 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-3.5 w-56 animate-pulse rounded bg-muted/60" />
      </div>
      <div className="flex-1 space-y-3 p-6">
        <div className="h-9 w-full animate-pulse rounded bg-muted/60" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-9 w-full animate-pulse rounded bg-muted/40" />
        ))}
      </div>
    </div>
  );
}

/**
 * Guards data pages — redirects to onboarding if no project is active.
 */
function RequireProject({ children }: { children: React.ReactNode }) {
  useProjectContext(); // subscribe to changes
  if (!hasActiveProject()) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

/**
 * Root route: if a project is already active, go straight to dashboard.
 */
function RootRedirect() {
  useProjectContext();
  if (hasActiveProject()) {
    return <Navigate to="/dashboard" replace />;
  }
  return (
    <Suspense fallback={<PageFallback />}>
      <OnboardingPage />
    </Suspense>
  );
}

export default function App() {
  return (
    <TooltipProvider delayDuration={200}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<RootRedirect />} />
          <Route
            path="dashboard"
            element={
              <RequireProject>
                <Suspense fallback={<PageFallback />}>
                  <DashboardPage />
                </Suspense>
              </RequireProject>
            }
          />
          <Route
            path="traces"
            element={
              <RequireProject>
                <Suspense fallback={<PageFallback />}>
                  <TracesPage />
                </Suspense>
              </RequireProject>
            }
          />
          <Route
            path="traces/:traceId"
            element={
              <RequireProject>
                <Suspense fallback={<PageFallback />}>
                  <TraceDetailPage />
                </Suspense>
              </RequireProject>
            }
          />
          <Route
            path="sessions"
            element={
              <RequireProject>
                <Suspense fallback={<PageFallback />}>
                  <SessionsPage />
                </Suspense>
              </RequireProject>
            }
          />
          <Route
            path="sessions/:sessionId"
            element={
              <RequireProject>
                <Suspense fallback={<PageFallback />}>
                  <SessionDetailPage />
                </Suspense>
              </RequireProject>
            }
          />
          <Route
            path="observations"
            element={
              <RequireProject>
                <Suspense fallback={<PageFallback />}>
                  <ObservationsPage />
                </Suspense>
              </RequireProject>
            }
          />
          <Route
            path="users"
            element={
              <RequireProject>
                <Suspense fallback={<PageFallback />}>
                  <UsersPage />
                </Suspense>
              </RequireProject>
            }
          />
          <Route
            path="scores"
            element={
              <RequireProject>
                <Suspense fallback={<PageFallback />}>
                  <ScoresPage />
                </Suspense>
              </RequireProject>
            }
          />
          <Route
            path="settings"
            element={
              <RequireProject>
                <Suspense fallback={<PageFallback />}>
                  <SettingsPage />
                </Suspense>
              </RequireProject>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </TooltipProvider>
  );
}
