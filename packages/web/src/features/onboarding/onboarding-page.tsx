/**
 * Onboarding — Spectra §8.
 *
 * Shown when no project is active. A centered welcome screen: brand hero,
 * a create-project card with the existing-project list beneath it, and a
 * short row of product value props. Logic is unchanged (React Query
 * mutations + toast); only the presentation is redesigned.
 */

import { Activity, ChevronRight, Database, FolderPlus, Gauge, Loader2, Star } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "@/shared/components/toast";
import { Button } from "@/shared/components/ui/button";
import { Card, CardContent } from "@/shared/components/ui/card";
import { Input } from "@/shared/components/ui/input";
import { Skeleton } from "@/shared/components/ui/skeleton";
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
    body: "Understand latency, tokens and cost per model.",
  },
];

export function OnboardingPage() {
  const navigate = useNavigate();
  const [newName, setNewName] = useState("");

  const projectsQuery = useProjectsQuery();
  const createProject = useCreateProjectMutation();
  const activateProject = useActivateProjectMutation();

  const projects = projectsQuery.data ?? [];

  const enterProject = (projectId: string) => {
    activateProject.mutate(projectId, {
      onSuccess: (ctx) => {
        setProjectContext(ctx);
        navigate("/dashboard");
      },
      onError: (err) =>
        toast.error("Failed to activate project", err instanceof Error ? err.message : undefined),
    });
  };

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) return;
    createProject.mutate(name, {
      onSuccess: (project) => {
        toast.success(`Project "${name}" created`);
        enterProject(project.id);
      },
      onError: (err) =>
        toast.error("Failed to create project", err instanceof Error ? err.message : undefined),
    });
  };

  const busy = createProject.isPending || activateProject.isPending;

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-md">
        {/* Hero */}
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand shadow-sm">
            <Database className="h-6 w-6 text-brand-fg" />
          </div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-fg-primary">
            Peri-Fuse
            <span className="ml-2 align-middle text-xs font-medium uppercase tracking-[0.1em] text-fg-tertiary">
              Lite
            </span>
          </h1>
          <p className="mt-2 max-w-sm text-sm text-fg-tertiary">
            Lightweight, self-hosted LLM observability. Create a project to start tracing your
            applications.
          </p>
        </div>

        {/* Create / open project */}
        <Card className="border-line bg-surface-raised shadow-sm">
          <CardContent className="p-4">
            <label
              htmlFor="new-project"
              className="mb-2 block text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary"
            >
              Create a new project
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="new-project"
                placeholder="Project name…"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                autoFocus
              />
              <Button onClick={handleCreate} disabled={!newName.trim() || busy}>
                {createProject.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FolderPlus className="h-4 w-4" />
                )}
                Create
              </Button>
            </div>

            <div className="my-4 flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                Or open existing
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>

            {projectsQuery.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 2 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : projects.length === 0 ? (
              <p className="py-2 text-center text-sm text-fg-tertiary">
                No projects yet — create your first one above.
              </p>
            ) : (
              <div className="space-y-1.5">
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={busy}
                    onClick={() => enterProject(p.id)}
                    className="group flex w-full items-center gap-3 rounded-md border border-line px-3.5 py-2.5 text-left transition-colors duration-150 hover:border-line-strong hover:bg-surface-overlay/60 disabled:opacity-60"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-subtle text-brand">
                      <Database className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-fg-primary">{p.name}</p>
                      <p className="truncate text-xs text-fg-tertiary">
                        {p.orgName} · {p.keyCount} key{p.keyCount !== 1 ? "s" : ""}
                      </p>
                    </div>
                    {activateProject.isPending && activateProject.variables === p.id ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-fg-tertiary" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-fg-tertiary transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-fg-primary" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Value props */}
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {highlights.map((h) => (
            <div key={h.title} className="flex flex-col items-center gap-1.5 text-center">
              <h.icon className="h-4 w-4 text-brand" strokeWidth={1.75} />
              <p className="text-[13px] font-medium text-fg-secondary">{h.title}</p>
              <p className="text-xs leading-relaxed text-fg-tertiary">{h.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
