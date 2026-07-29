import { Check, ChevronDown, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { activateProject, createProject, listProjects } from "@/lib/api";
import type { Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import { setProjectContext, useProjectContext } from "@/store/project";

export function ProjectSwitcher() {
  const ctx = useProjectContext();
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      setProjects(await listProjects());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  const handleOpen = () => {
    setOpen((v) => !v);
    if (!open) loadProjects();
  };

  const handleSwitch = async (projectId: string) => {
    setSwitching(projectId);
    try {
      const result = await activateProject(projectId);
      setProjectContext(result);
      setOpen(false);
    } catch {
      // ignore
    } finally {
      setSwitching(null);
    }
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const project = await createProject(name);
      const result = await activateProject(project.id);
      setProjectContext(result);
      setNewName("");
      setOpen(false);
    } catch {
      // ignore
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="relative px-2" ref={ref}>
      <button
        type="button"
        onClick={handleOpen}
        className="flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent/50"
      >
        <span className="truncate">{ctx?.projectName ?? "Select project"}</span>
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-2 right-2 top-full z-50 mt-1 rounded-md border border-border bg-popover p-1 shadow-md">
          {loading ? (
            <div className="flex items-center justify-center py-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="max-h-48 space-y-0.5 overflow-y-auto">
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={switching !== null}
                  onClick={() => handleSwitch(p.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent",
                    p.id === ctx?.projectId && "bg-accent/50 font-medium",
                  )}
                >
                  {switching === p.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : p.id === ctx?.projectId ? (
                    <Check className="h-3.5 w-3.5 text-primary" />
                  ) : (
                    <span className="w-3.5" />
                  )}
                  <span className="truncate">{p.name}</span>
                </button>
              ))}
            </div>
          )}

          {/* Create new project */}
          <div className="mt-1 border-t border-border pt-1">
            <div className="flex items-center gap-1 px-1 py-1">
              <Input
                className="h-7 text-xs"
                placeholder="New project…"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                disabled={!newName.trim() || creating}
                onClick={handleCreate}
              >
                {creating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
