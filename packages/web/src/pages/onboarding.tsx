import { Database, FolderPlus, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { activateProject, createProject, listProjects } from "@/lib/api";
import type { Project } from "@/lib/types";
import { setProjectContext } from "@/store/project";

export function OnboardingPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [activating, setActivating] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch {
      // server may not be ready
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const enterProject = async (projectId: string) => {
    setActivating(projectId);
    setError("");
    try {
      const ctx = await activateProject(projectId);
      setProjectContext(ctx);
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to activate project");
    } finally {
      setActivating(null);
    }
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError("");
    try {
      const project = await createProject(name);
      const ctx = await activateProject(project.id);
      setProjectContext(ctx);
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-8">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Database className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>Welcome to Peri-Fuse</CardTitle>
          <CardDescription>
            Create a project to start observing your LLM applications.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Create new project */}
          <div className="flex items-center gap-2">
            <Input
              placeholder="Project name…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              autoFocus
            />
            <Button onClick={handleCreate} disabled={!newName.trim() || creating}>
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FolderPlus className="h-4 w-4" />
              )}
              Create
            </Button>
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          {/* Existing projects */}
          {!loading && projects.length > 0 && (
            <div className="space-y-2 pt-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Or select an existing project
              </p>
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={activating !== null}
                  onClick={() => enterProject(p.id)}
                  className="flex w-full items-center justify-between rounded-md border border-border px-4 py-3 text-left text-sm transition-colors hover:bg-accent/50"
                >
                  <span className="font-medium">{p.name}</span>
                  {activating === p.id ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {p.keyCount} key{p.keyCount !== 1 ? "s" : ""}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
