/**
 * Onboarding — project selection and creation via the manage API.
 *
 * Shown when no project is active. Lists existing projects, supports create +
 * activate, then navigates to the dashboard.
 */

import { Button, Card, CardContent, Input, message, Skeleton } from "@peri/ui";
import { useNavigate } from "@solidjs/router";
import {
  Activity,
  AlertCircle,
  ChevronRight,
  Database,
  FolderPlus,
  Gauge,
  Loader2,
  Star,
} from "lucide-solid";
import { type Component, createSignal, For, Show } from "solid-js";
import {
  useActivateProjectMutation,
  useCreateProjectMutation,
  useProjectsQuery,
} from "@/shared/hooks/queries";
import { setProjectContext } from "@/shared/store/project";

const highlights = [
  {
    icon: Activity,
    title: "Trace",
    body: "Capture every LLM call, agent step and tool use.",
  },
  {
    icon: Star,
    title: "Evaluate",
    body: "Attach scores to track output quality over time.",
  },
  {
    icon: Gauge,
    title: "Optimize",
    body: "Understand latency, tokens and cache hits per model.",
  },
];

export const OnboardingPage: Component = () => {
  const navigate = useNavigate();
  const [newName, setNewName] = createSignal("");

  const projectsQuery = useProjectsQuery();
  const createProject = useCreateProjectMutation();
  const activateProject = useActivateProjectMutation();

  const projects = () => (projectsQuery.isSuccess ? projectsQuery.data : []);
  const hasCachedProjects = () => projectsQuery.isSuccess || projectsQuery.isError;
  const projectError = () => projectsQuery.error;

  const enterProject = (projectId: string) => {
    activateProject.mutate(projectId, {
      onSuccess: (ctx) => {
        setProjectContext(ctx);
        navigate("/dashboard");
      },
      onError: (err) =>
        message.error(err instanceof Error ? err.message : "Failed to activate project"),
    });
  };

  const handleCreate = () => {
    const name = newName().trim();
    if (!name) return;
    createProject.mutate(name, {
      onSuccess: (project) => {
        message.success(`Project "${name}" created`);
        enterProject(project.id);
      },
      onError: (err) =>
        message.error(err instanceof Error ? err.message : "Failed to create project"),
    });
  };

  const busy = () => createProject.isPending || activateProject.isPending;

  return (
    <div class="flex min-h-full flex-col items-center justify-center px-24 py-48">
      <div class="w-full max-w-md">
        <div class="mb-32 flex flex-col items-center text-center">
          <div class="mb-16 flex h-48 w-48 items-center justify-center rounded-xl bg-brand shadow-sm">
            <Database class="h-24 w-24 text-brand-fg" size={24} />
          </div>
          <h1 class="text-2xl font-semibold tracking-[-0.02em] text-fg-primary">
            Peri-Fuse
            <span class="ml-8 align-middle text-xs font-medium uppercase tracking-[0.1em] text-fg-tertiary">
              Lite
            </span>
          </h1>
          <p class="mt-8 max-w-sm text-sm text-fg-tertiary">
            Lightweight, self-hosted LLM observability. Create a project to start tracing your
            applications.
          </p>
        </div>

        <Card class="border-line bg-surface-raised shadow-sm">
          <CardContent class="p-16">
            <label
              for="new-project"
              class="mb-8 block text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary"
            >
              Create a new project
            </label>
            <div class="flex items-center gap-8">
              <Input
                id="new-project"
                placeholder="Project name…"
                value={newName()}
                onInput={(e) => setNewName(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                autofocus
              />
              <Button
                variant="primary"
                onClick={handleCreate}
                disabled={!newName().trim() || busy()}
                busy={createProject.isPending}
                leadingIcon={
                  createProject.isPending ? (
                    <Loader2 class="h-16 w-16 animate-spin" size={16} />
                  ) : (
                    <FolderPlus class="h-16 w-16" size={16} />
                  )
                }
              >
                Create
              </Button>
            </div>

            <div class="my-16 flex items-center gap-12">
              <span class="h-px flex-1 bg-border" />
              <span class="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                Or open existing
              </span>
              <span class="h-px flex-1 bg-border" />
            </div>

            <Show
              when={!(projectsQuery.isPending && !projectError() && !hasCachedProjects())}
              fallback={
                <div class="space-y-8">
                  <Skeleton class="h-48 w-full" />
                  <Skeleton class="h-48 w-full" />
                </div>
              }
            >
              <div class="space-y-8">
                <Show when={projectError()}>
                  <div
                    role="alert"
                    class="flex items-start gap-8 rounded-md border border-danger/30 bg-danger-subtle p-12"
                  >
                    <AlertCircle
                      aria-hidden="true"
                      class="mt-2 h-16 w-16 shrink-0 text-danger"
                      size={16}
                    />
                    <div class="min-w-0 flex-1">
                      <p class="text-sm font-medium text-danger">Couldn't load projects</p>
                      <p class="break-words text-xs text-fg-secondary">
                        {projectError() instanceof Error
                          ? projectError()?.message
                          : "Please try again."}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      class="shrink-0"
                      disabled={projectsQuery.isFetching}
                      onClick={() => void projectsQuery.refetch()}
                      busy={projectsQuery.isFetching}
                    >
                      Retry
                    </Button>
                  </div>
                </Show>

                <Show when={hasCachedProjects()}>
                  <Show
                    when={projects().length > 0}
                    fallback={
                      <p class="py-8 text-center text-sm text-fg-tertiary">
                        No projects yet — create your first one above.
                      </p>
                    }
                  >
                    <div class="space-y-24">
                      <For each={projects()}>
                        {(p) => (
                          <button
                            type="button"
                            disabled={busy()}
                            onClick={() => enterProject(p.id)}
                            class="group flex w-full items-center gap-12 rounded-md border border-line px-14 py-10 text-left transition-colors duration-150 hover:border-line-strong hover:bg-surface-overlay/60 disabled:opacity-60"
                          >
                            <div class="flex h-32 w-32 shrink-0 items-center justify-center rounded-md bg-brand-subtle text-brand">
                              <Database class="h-16 w-16" size={16} />
                            </div>
                            <div class="min-w-0 flex-1">
                              <p class="truncate text-sm font-medium text-fg-primary">{p.name}</p>
                              <p class="truncate text-xs text-fg-tertiary">
                                {p.orgName} · {p.keyCount} key{p.keyCount !== 1 ? "s" : ""}
                              </p>
                            </div>
                            <Show
                              when={activateProject.isPending && activateProject.variables === p.id}
                              fallback={
                                <ChevronRight
                                  class="h-16 w-16 shrink-0 text-fg-tertiary transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-fg-primary"
                                  size={16}
                                />
                              }
                            >
                              <Loader2
                                class="h-16 w-16 shrink-0 animate-spin text-fg-tertiary"
                                size={16}
                              />
                            </Show>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </div>
            </Show>
          </CardContent>
        </Card>

        <div class="mt-32 grid grid-cols-1 gap-16 sm:grid-cols-3">
          <For each={highlights}>
            {(h) => (
              <div class="flex flex-col items-center gap-6 text-center">
                <h.icon class="h-16 w-16 text-brand" strokeWidth={1.75} size={16} />
                <p class="text-[13px] font-medium text-fg-secondary">{h.title}</p>
                <p class="text-xs leading-relaxed text-fg-tertiary">{h.body}</p>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
};
