import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import { Layout } from "@/components/layout";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DashboardPage } from "@/pages/dashboard";
import { ObservationsPage } from "@/pages/observations";
import { ScoresPage } from "@/pages/scores";
import { SessionDetailPage } from "@/pages/session-detail";
import { SessionsPage } from "@/pages/sessions";
import { SettingsPage } from "@/pages/settings";
import { TraceDetailPage } from "@/pages/trace-detail";
import { TracesPage } from "@/pages/traces";
import { isAuthConfigured, useAuthConfig } from "@/store/auth";

/**
 * Redirects to /settings until API credentials are configured. The settings
 * page itself is always reachable.
 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const config = useAuthConfig();
  const location = useLocation();
  if (!isAuthConfigured(config)) {
    return <Navigate to="/settings" replace state={{ from: location }} />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <TooltipProvider delayDuration={200}>
      <Routes>
        <Route element={<Layout />}>
          <Route
            index
            element={
              <RequireAuth>
                <DashboardPage />
              </RequireAuth>
            }
          />
          <Route
            path="traces"
            element={
              <RequireAuth>
                <TracesPage />
              </RequireAuth>
            }
          />
          <Route
            path="traces/:traceId"
            element={
              <RequireAuth>
                <TraceDetailPage />
              </RequireAuth>
            }
          />
          <Route
            path="sessions"
            element={
              <RequireAuth>
                <SessionsPage />
              </RequireAuth>
            }
          />
          <Route
            path="sessions/:sessionId"
            element={
              <RequireAuth>
                <SessionDetailPage />
              </RequireAuth>
            }
          />
          <Route
            path="observations"
            element={
              <RequireAuth>
                <ObservationsPage />
              </RequireAuth>
            }
          />
          <Route
            path="scores"
            element={
              <RequireAuth>
                <ScoresPage />
              </RequireAuth>
            }
          />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </TooltipProvider>
  );
}
