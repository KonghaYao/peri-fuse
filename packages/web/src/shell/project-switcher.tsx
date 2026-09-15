/**
 * Project switcher — sidebar dropdown for list/switch/create projects.
 */

import { Button, Input, message } from "@peri/ui";
import { AlertCircle, Check, ChevronDown, Loader2, Plus } from "lucide-solid";
import { type Component, createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import {
  useActivateProjectMutation,
  useCreateProjectMutation,
  useProjectsQuery,
} from "@/shared/hooks/queries";
import { cn } from "@/shared/lib/utils";
import { setProjectContext, useProjectContext } from "@/shared/store/project";

export const ProjectSwitcher: Component<{
  collapsed?: boolean;
  onNavigate?: () => void;
}> = (props) => {
  const ctx = useProjectContext();
  const [open, setOpen] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  let rootRef: HTMLDivElement | undefined;

  const projectsQuery = useProjectsQuery();
  const activateMutation = useActivateProjectMutation();
  const createMutation = useCreateProjectMutation();

  createEffect(() => {
    if (!open()) return;
    const handleClick = (e: MouseEvent) => {
      if (rootRef && !rootRef.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    });
  });

  createEffect(() => {
    if (open()) void projectsQuery.refetch();
  });

  const busy = () => activateMutation.isPending || createMutation.isPending;

  const handleSwitch = async (projectId: string) => {
    try {
      const result = await activateMutation.mutateAsync(projectId);
      setProjectContext(result);
      setOpen(false);
      props.onNavigate?.();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to switch project");
    }
  };

  const handleCreate = async () => {
    const name = newName().trim();
    if (!name || createMutation.isPending) return;
    try {
      const project = await createMutation.mutateAsync(name);
      const result = await activateMutation.mutateAsync(project.id);
      setProjectContext(result);
      message.success(`Project "${name}" created`);
      setNewName("");
      setOpen(false);
      props.onNavigate?.();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to create project");
    }
  };

  const projects = () => (projectsQuery.isSuccess ? projectsQuery.data : []);
  const hasCachedProjects = () => projectsQuery.isSuccess || projectsQuery.isError;
  const projectError = () => projectsQuery.error;

  return (
    <div class="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={props.collapsed ? (ctx()?.projectName ?? "Select project") : undefined}
        class={cn(
          "flex h-[34px] w-full items-center gap-8 rounded-md border border-border px-10 text-[13px] font-medium transition-colors duration-150 hover:border-line-strong hover:bg-surface-overlay/60",
          props.collapsed && "justify-center border-0 px-0 hover:border-0",
        )}
      >
        <span class="h-8 w-8 shrink-0 rounded-full bg-brand" />
        <Show when={!props.collapsed}>
          <span class="min-w-0 flex-1 truncate text-left text-fg-primary">
            {ctx()?.projectName ?? "Select project"}
          </span>
          <ChevronDown
            class={cn(
              "h-14 w-14 shrink-0 text-fg-tertiary transition-transform duration-150",
              open() && "rotate-180",
            )}
            size={14}
          />
        </Show>
      </button>

      <Show when={open()}>
        <div
          class={cn(
            "absolute top-full z-50 mt-4 w-224 rounded-lg border border-border bg-popover p-4 shadow-md",
            props.collapsed ? "left-0" : "left-0 right-0 w-auto",
          )}
        >
          <p class="px-8 pb-4 pt-6 text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
            Projects
          </p>

          <Show
            when={!(projectsQuery.isPending && !projectError() && !hasCachedProjects())}
            fallback={
              <div class="flex items-center justify-center py-12">
                <Loader2 class="h-16 w-16 animate-spin text-fg-tertiary" size={16} />
              </div>
            }
          >
            <div class="space-y-4">
              <Show when={projectError()}>
                <div
                  role="alert"
                  class="flex items-start gap-6 rounded-md border border-danger/30 bg-danger-subtle p-8"
                >
                  <AlertCircle
                    aria-hidden="true"
                    class="mt-2 h-14 w-14 shrink-0 text-danger"
                    size={14}
                  />
                  <div class="min-w-0 flex-1">
                    <p class="text-xs font-medium text-danger">Couldn't load projects</p>
                    <p class="break-words text-[11px] text-fg-secondary">
                      {projectError() instanceof Error
                        ? projectError()?.message
                        : "Please try again."}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    class="shrink-0 px-6 text-danger"
                    disabled={projectsQuery.isFetching}
                    onClick={() => void projectsQuery.refetch()}
                    busy={projectsQuery.isFetching}
                  >
                    Retry
                  </Button>
                </div>
              </Show>

              <Show when={hasCachedProjects()}>
                <div class="max-h-208 space-y-2 overflow-y-auto">
                  <For each={projects()}>
                    {(p) => {
                      const isCurrent = () => p.id === ctx()?.projectId;
                      return (
                        <button
                          type="button"
                          disabled={busy()}
                          onClick={() => handleSwitch(p.id)}
                          class={cn(
                            "flex w-full items-center gap-8 rounded-md px-8 py-6 text-[13px] transition-colors duration-150 hover:bg-surface-overlay/70",
                            isCurrent()
                              ? "bg-brand-subtle font-medium text-brand"
                              : "text-fg-primary",
                            busy() && "opacity-60",
                          )}
                        >
                          <Show
                            when={activateMutation.isPending && activateMutation.variables === p.id}
                            fallback={
                              <Show when={isCurrent()} fallback={<span class="w-14 shrink-0" />}>
                                <Check class="h-14 w-14 shrink-0" size={14} />
                              </Show>
                            }
                          >
                            <Loader2 class="h-14 w-14 shrink-0 animate-spin" size={14} />
                          </Show>
                          <span class="truncate">{p.name}</span>
                        </button>
                      );
                    }}
                  </For>
                  <Show when={projects().length === 0}>
                    <p class="px-8 py-6 text-sm text-fg-tertiary">No projects yet</p>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>

          <div class="mt-4 border-t border-border pt-4">
            <div class="flex items-center gap-4 p-4">
              <Input
                class="h-28 text-xs"
                placeholder="New project…"
                value={newName()}
                onInput={(e) => setNewName(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleCreate()}
              />
              <button
                type="button"
                disabled={!newName().trim() || createMutation.isPending}
                onClick={() => void handleCreate()}
                class="flex h-28 w-28 shrink-0 items-center justify-center rounded-md text-fg-secondary transition-colors hover:bg-surface-overlay/70 hover:text-fg-primary disabled:pointer-events-none disabled:opacity-40"
                aria-label="Create project"
              >
                <Show
                  when={createMutation.isPending}
                  fallback={<Plus class="h-14 w-14" size={14} />}
                >
                  <Loader2 class="h-14 w-14 animate-spin" size={14} />
                </Show>
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};
