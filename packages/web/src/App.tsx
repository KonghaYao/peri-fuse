import { Navigate, Route, Router } from "@solidjs/router";
import { lazy, type ParentComponent, Suspense } from "solid-js";
import { OnboardingPage } from "@/pages/onboarding-page";
import {
  ProjectCredentialGate,
  RequireProjectRedirect,
} from "@/shared/components/project-credential-gate";
import { Layout } from "@/shell/layout";

const DashboardPage = lazy(async () => {
  const mod = await import("@/pages/dashboard-page");
  return { default: mod.DashboardPage };
});
const ErrorsPage = lazy(async () => {
  const mod = await import("@/pages/errors-page");
  return { default: mod.ErrorsPage };
});
const TracesPage = lazy(async () => {
  const mod = await import("@/pages/traces-page");
  return { default: mod.TracesPage };
});
const TraceDetailPage = lazy(async () => {
  const mod = await import("@/pages/trace-detail-page");
  return { default: mod.TraceDetailPage };
});
const SessionsPage = lazy(async () => {
  const mod = await import("@/pages/sessions-page");
  return { default: mod.SessionsPage };
});
const SessionDetailPage = lazy(async () => {
  const mod = await import("@/pages/session-detail-page");
  return { default: mod.SessionDetailPage };
});
const UsersPage = lazy(async () => {
  const mod = await import("@/pages/users-page");
  return { default: mod.UsersPage };
});
const ObservationsPage = lazy(async () => {
  const mod = await import("@/pages/observations-page");
  return { default: mod.ObservationsPage };
});
const ScoresPage = lazy(async () => {
  const mod = await import("@/pages/scores-page");
  return { default: mod.ScoresPage };
});
const SettingsPage = lazy(async () => {
  const mod = await import("@/pages/settings-page");
  return { default: mod.SettingsPage };
});
const GatewayOverviewPage = lazy(async () => {
  const mod = await import("@/pages/gateway-overview-page");
  return { default: mod.GatewayOverviewPage };
});
const GatewayProvidersPage = lazy(async () => {
  const mod = await import("@/pages/gateway-providers-page");
  return { default: mod.GatewayProvidersPage };
});
const GatewayModelsPage = lazy(async () => {
  const mod = await import("@/pages/gateway-models-page");
  return { default: mod.GatewayModelsPage };
});
const GatewayUsagePage = lazy(async () => {
  const mod = await import("@/pages/gateway-usage-page");
  return { default: mod.GatewayUsagePage };
});
const GatewayLogsPage = lazy(async () => {
  const mod = await import("@/pages/gateway-logs-page");
  return { default: mod.GatewayLogsPage };
});

function PageFallback() {
  return (
    <div class="flex h-full flex-col">
      <div class="border-b border-border px-24 py-16">
        <div class="h-20 w-128 animate-pulse rounded bg-muted" />
        <div class="mt-8 h-14 w-224 animate-pulse rounded bg-muted/60" />
      </div>
      <div class="flex-1 space-y-12 p-24">
        <div class="h-36 w-full animate-pulse rounded bg-muted/60" />
        {Array.from({ length: 8 }).map(() => (
          <div class="h-36 w-full animate-pulse rounded bg-muted/40" />
        ))}
      </div>
    </div>
  );
}

function SuspensePage(props: { children: ParentComponent }) {
  const Page = props.children;
  return (
    <Suspense fallback={<PageFallback />}>
      <Page />
    </Suspense>
  );
}

function GuardedPage(props: { children: ParentComponent }) {
  const Page = props.children;
  return (
    <RequireProjectRedirect>
      <Suspense fallback={<PageFallback />}>
        <Page />
      </Suspense>
    </RequireProjectRedirect>
  );
}

function RootRedirect() {
  return (
    <ProjectCredentialGate fallback={<OnboardingPage />}>
      <Navigate href="/dashboard" />
    </ProjectCredentialGate>
  );
}

export default function App() {
  return (
    <Router root={Layout}>
      <Route path="/" component={RootRedirect} />
      <Route path="/dashboard" component={() => <GuardedPage>{DashboardPage}</GuardedPage>} />
      <Route path="/traces" component={() => <GuardedPage>{TracesPage}</GuardedPage>} />
      <Route path="/errors" component={() => <GuardedPage>{ErrorsPage}</GuardedPage>} />
      <Route
        path="/traces/:traceId"
        component={() => <GuardedPage>{TraceDetailPage}</GuardedPage>}
      />
      <Route path="/sessions" component={() => <GuardedPage>{SessionsPage}</GuardedPage>} />
      <Route
        path="/sessions/:sessionId"
        component={() => <GuardedPage>{SessionDetailPage}</GuardedPage>}
      />
      <Route path="/observations" component={() => <GuardedPage>{ObservationsPage}</GuardedPage>} />
      <Route path="/users" component={() => <GuardedPage>{UsersPage}</GuardedPage>} />
      <Route path="/scores" component={() => <GuardedPage>{ScoresPage}</GuardedPage>} />
      <Route path="/settings" component={() => <GuardedPage>{SettingsPage}</GuardedPage>} />
      <Route path="/gateway" component={() => <SuspensePage>{GatewayOverviewPage}</SuspensePage>} />
      <Route
        path="/gateway/providers"
        component={() => <SuspensePage>{GatewayProvidersPage}</SuspensePage>}
      />
      <Route
        path="/gateway/models"
        component={() => <SuspensePage>{GatewayModelsPage}</SuspensePage>}
      />
      <Route
        path="/gateway/usage"
        component={() => <SuspensePage>{GatewayUsagePage}</SuspensePage>}
      />
      <Route
        path="/gateway/logs"
        component={() => <SuspensePage>{GatewayLogsPage}</SuspensePage>}
      />
      <Route path="*" component={() => <Navigate href="/" />} />
    </Router>
  );
}
