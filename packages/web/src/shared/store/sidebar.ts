/**
 * Sidebar collapsed state — persisted to localStorage.
 */
import { createSignal } from "solid-js";

const STORAGE_KEY = "peri-fuse-sidebar-collapsed";

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

const [collapsed, setCollapsedSignal] = createSignal<boolean>(read());

export function getSidebarCollapsed(): boolean {
  return collapsed();
}

export function setSidebarCollapsed(next: boolean): void {
  setCollapsedSignal(next);
  try {
    localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    // ignore
  }
}

export function toggleSidebarCollapsed(): void {
  setSidebarCollapsed(!collapsed());
}

export function useSidebarCollapsed() {
  return collapsed;
}
