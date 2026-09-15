/**
 * Validates persisted project credentials before rendering guarded routes.
 *
 * Prevents stale localStorage keys (common after a DB swap) from redirecting
 * into observability pages that immediately 401 and bounce back to onboarding.
 */
import { Navigate } from "@solidjs/router";
import { Skeleton } from "@peri/ui";
import { type JSX, type ParentComponent, Show, createSignal, onMount } from "solid-js";
import { verifyStoredProjectCredentials } from "@/shared/lib/api";
import { hasActiveProject, useProjectContext } from "@/shared/store/project";

function GateLoading() {
  return (
    <div class="flex min-h-full flex-col items-center justify-center px-24 py-48">
      <div class="w-full max-w-md space-y-12">
        <Skeleton class="mx-auto h-48 w-48 rounded-xl" />
        <Skeleton class="h-20 w-160 mx-auto" />
        <Skeleton class="h-160 w-full rounded-lg" />
      </div>
    </div>
  );
}

export const ProjectCredentialGate: ParentComponent<{
  fallback: JSX.Element;
}> = (props) => {
  useProjectContext();
  const [ready, setReady] = createSignal(!hasActiveProject());

  onMount(() => {
    void (async () => {
      if (!hasActiveProject()) {
        setReady(true);
        return;
      }
      await verifyStoredProjectCredentials();
      setReady(true);
    })();
  });

  return (
    <Show when={ready()} fallback={<GateLoading />}>
      <Show when={hasActiveProject()} fallback={props.fallback}>
        {props.children}
      </Show>
    </Show>
  );
};

export const RequireProjectRedirect: ParentComponent = (props) => (
  <ProjectCredentialGate fallback={<Navigate href="/" />}>{props.children}</ProjectCredentialGate>
);
