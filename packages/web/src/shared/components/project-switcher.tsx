/**
 * Project switcher — Spectra §6.4.
 *
 * Single-line 34px trigger: status dot + project name + chevron (never a
 * two-line layout). When the sidebar is collapsed it shrinks to the dot.
 * Dropdown lists projects with an inline "create" row.
 */
import { Check, ChevronDown, Loader2, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { toast } from "@/shared/components/toast";
import { Input } from "@/shared/components/ui/input";
import {
  useActivateProjectMutation,
  useCreateProjectMutation,
  useProjectsQuery,
} from "@/shared/hooks/queries";
import { cn } from "@/shared/lib/utils";
import { setProjectContext, useProjectContext } from "@/shared/store/project";

export function ProjectSwitcher({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const ctx = useProjectContext();
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const projectsQuery = useProjectsQuery();
  const activateMutation = useActivateProjectMutation();
  const createMutation = useCreateProjectMutation();

  // Close dropdown on outside click / Escape.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, []);

  // Refresh the list each time the dropdown opens.
  useEffect(() => {
    if (open) void projectsQuery.refetch();
  }, [open, projectsQuery.refetch]);

  const busy = activateMutation.isPending || createMutation.isPending;

  const handleSwitch = async (projectId: string) => {
    try {
      const result = await activateMutation.mutateAsync(projectId);
      setProjectContext(result);
      setOpen(false);
      onNavigate?.();
    } catch (err) {
      toast.error("Failed to switch project", err instanceof Error ? err.message : undefined);
    }
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || createMutation.isPending) return;
    try {
      const project = await createMutation.mutateAsync(name);
      const result = await activateMutation.mutateAsync(project.id);
      setProjectContext(result);
      toast.success(`Project "${name}" created`);
      setNewName("");
      setOpen(false);
      onNavigate?.();
    } catch (err) {
      toast.error("Failed to create project", err instanceof Error ? err.message : undefined);
    }
  };

  const projects = projectsQuery.data ?? [];

  return (
    <div className="relative" ref={ref}>
      {/* Trigger — single line, 34px */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={collapsed ? (ctx?.projectName ?? "Select project") : undefined}
        className={cn(
          "flex h-[34px] w-full items-center gap-2 rounded-md border border-border px-2.5 text-[13px] font-medium transition-colors duration-150 hover:border-line-strong hover:bg-surface-overlay/60",
          collapsed && "justify-center border-0 px-0 hover:border-0",
        )}
      >
        <span className="h-2 w-2 shrink-0 rounded-full bg-brand" />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-left text-fg-primary">
              {ctx?.projectName ?? "Select project"}
            </span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-fg-tertiary transition-transform duration-150",
                open && "rotate-180",
              )}
            />
          </>
        )}
      </button>

      {open && (
        <div
          className={cn(
            "absolute top-full z-50 mt-1 w-56 rounded-lg border border-border bg-popover p-1 shadow-md",
            collapsed ? "left-0" : "left-0 right-0 w-auto",
          )}
        >
          <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
            Projects
          </p>

          {projectsQuery.isLoading ? (
            <div className="flex items-center justify-center py-3">
              <Loader2 className="h-4 w-4 animate-spin text-fg-tertiary" />
            </div>
          ) : (
            <div className="max-h-52 space-y-0.5 overflow-y-auto">
              {projects.map((p) => {
                const isCurrent = p.id === ctx?.projectId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={busy}
                    onClick={() => handleSwitch(p.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors duration-150 hover:bg-surface-overlay/70",
                      isCurrent ? "bg-brand-subtle font-medium text-brand" : "text-fg-primary",
                      busy && "opacity-60",
                    )}
                  >
                    {activateMutation.isPending && activateMutation.variables === p.id ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    ) : isCurrent ? (
                      <Check className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <span className="w-3.5 shrink-0" />
                    )}
                    <span className="truncate">{p.name}</span>
                  </button>
                );
              })}
              {projects.length === 0 && (
                <p className="px-2 py-1.5 text-sm text-fg-tertiary">No projects yet</p>
              )}
            </div>
          )}

          {/* Create new project */}
          <div className="mt-1 border-t border-border pt-1">
            <div className="flex items-center gap-1 p-1">
              <Input
                className="h-7 text-xs"
                placeholder="New project…"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
              <button
                type="button"
                disabled={!newName.trim() || createMutation.isPending}
                onClick={handleCreate}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-secondary transition-colors hover:bg-surface-overlay/70 hover:text-fg-primary disabled:pointer-events-none disabled:opacity-40"
                aria-label="Create project"
              >
                {createMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
