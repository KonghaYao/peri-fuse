import { activateProject, createProject, listProjects } from "@/shared/lib/api";
import {
  clearProjectContext,
  getProjectContext,
  type ProjectContext,
  setProjectContext,
} from "./project";

export async function initializeProjectContext(): Promise<ProjectContext> {
  const projects = await listProjects();
  const current = getProjectContext();
  const existing = projects.find((project) => project.id === current?.projectId);
  if (current && existing) {
    const context = { ...current, projectName: existing.name };
    setProjectContext(context);
    return context;
  }

  clearProjectContext();
  const project =
    projects.find((candidate) => candidate.name === "Default Project") ??
    projects[0] ??
    (await createProject("Default Project"));
  const context = await activateProject(project.id);
  setProjectContext(context);
  return context;
}
