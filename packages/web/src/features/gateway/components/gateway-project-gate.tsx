import { Button, PageHeaderShell } from "@peri/ui";
import { A } from "@solidjs/router";
import { type Component, type JSX, Show } from "solid-js";
import { hasActiveProject, useProjectContext } from "@/shared/store/project";

export const GatewayProjectGate: Component<{
  title: string;
  description: string;
  children: JSX.Element;
}> = (props) => {
  useProjectContext();

  return (
    <Show
      when={hasActiveProject()}
      fallback={
        <div class="flex h-full flex-col">
          <PageHeaderShell title={props.title} description={props.description} />
          <div class="flex flex-1 items-center justify-center p-24">
            <div
              role="alert"
              class="max-w-md rounded-lg border border-warning/30 bg-warning-subtle px-16 py-12 text-center"
            >
              <p class="text-sm font-medium text-fg-primary">No active project</p>
              <p class="mt-4 text-sm text-fg-secondary">
                Gateway admin API calls require project credentials. Activate a project to manage
                providers, models, and usage.
              </p>
              <div class="mt-16">
                <A href="/">
                  <Button variant="primary" size="sm">
                    Go to onboarding
                  </Button>
                </A>
              </div>
            </div>
          </div>
        </div>
      }
    >
      {props.children}
    </Show>
  );
};
