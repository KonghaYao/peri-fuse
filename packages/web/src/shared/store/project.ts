/**
 * Active project context, persisted to localStorage.
 *
 * The web UI always operates within a single project. Switching projects
 * calls the manage API to obtain fresh credentials, then updates this store.
 */
import { createSignal } from "solid-js";

export type ProjectContext = {
  projectId: string;
  projectName: string;
  publicKey: string;
  secretKey: string;
};

const STORAGE_KEY = "peri-fuse-project";

function read(): ProjectContext | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProjectContext;
    if (!parsed.projectId || !parsed.publicKey || !parsed.secretKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

const [projectContext, setProjectContextSignal] = createSignal<ProjectContext | null>(read());

export function getProjectContext(): ProjectContext | null {
  return projectContext();
}

export function setProjectContext(ctx: ProjectContext): void {
  setProjectContextSignal(ctx);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ctx));
  } catch {
    // localStorage may be unavailable (private mode); keep in-memory only.
  }
}

export function clearProjectContext(): void {
  setProjectContextSignal(null);
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function hasActiveProject(): boolean {
  return projectContext() !== null;
}

/** Reactive accessor for the current project context. */
export function useProjectContext() {
  return projectContext;
}
