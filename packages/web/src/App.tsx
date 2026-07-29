import { Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "@/components/layout";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DashboardPage } from "@/pages/dashboard";
import { ObservationsPage } from "@/pages/observations";
import { OnboardingPage } from "@/pages/onboarding";
import { ScoresPage } from "@/pages/scores";
import { SessionDetailPage } from "@/pages/session-detail";
import { SessionsPage } from "@/pages/sessions";
import { SettingsPage } from "@/pages/settings";
import { TraceDetailPage } from "@/pages/trace-detail";
import { TracesPage } from "@/pages/traces";
import { hasActiveProject, useProjectContext } from "@/store/project";

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
  return <OnboardingPage />;
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
                <DashboardPage />
              </RequireProject>
            }
          />
          <Route
            path="traces"
            element={
              <RequireProject>
                <TracesPage />
              </RequireProject>
            }
          />
          <Route
            path="traces/:traceId"
            element={
              <RequireProject>
                <TraceDetailPage />
              </RequireProject>
            }
          />
          <Route
            path="sessions"
            element={
              <RequireProject>
                <SessionsPage />
              </RequireProject>
            }
          />
          <Route
            path="sessions/:sessionId"
            element={
              <RequireProject>
                <SessionDetailPage />
              </RequireProject>
            }
          />
          <Route
            path="observations"
            element={
              <RequireProject>
                <ObservationsPage />
              </RequireProject>
            }
          />
          <Route
            path="scores"
            element={
              <RequireProject>
                <ScoresPage />
              </RequireProject>
            }
          />
          <Route
            path="settings"
            element={
              <RequireProject>
                <SettingsPage />
              </RequireProject>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </TooltipProvider>
  );
}
