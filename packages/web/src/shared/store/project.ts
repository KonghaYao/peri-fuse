/**
 * Active project context, persisted to localStorage.
 *
 * The web UI always operates within a single project. Switching projects
 * calls the manage API to obtain fresh credentials, then updates this store.
 */
import { useSyncExternalStore } from "react";

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

let cache: ProjectContext | null = read();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function getProjectContext(): ProjectContext | null {
  return cache;
}

export function setProjectContext(ctx: ProjectContext): void {
  cache = ctx;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ctx));
  } catch {
    // localStorage may be unavailable (private mode); keep in-memory only.
  }
  emit();
}

export function clearProjectContext(): void {
  cache = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  emit();
}

export function hasActiveProject(): boolean {
  return cache !== null;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React hook returning the current project context (re-renders on change). */
export function useProjectContext(): ProjectContext | null {
  return useSyncExternalStore(subscribe, getProjectContext, getProjectContext);
}
