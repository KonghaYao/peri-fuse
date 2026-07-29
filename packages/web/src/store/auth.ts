/**
 * Lite-server connection + credentials, persisted to localStorage.
 *
 * The lite-server uses HTTP Basic auth with `publicKey:secretKey` (the same
 * credentials the Langfuse SDK uses). `baseUrl` is optional: when empty the
 * client calls same-origin `/api/public/*`, which works both behind the
 * lite-server's static hosting (production) and the Vite dev proxy (dev).
 */
import { useSyncExternalStore } from "react";

export type AuthConfig = {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
};

const STORAGE_KEY = "langfuse-lite-auth";

const empty: AuthConfig = { baseUrl: "", publicKey: "", secretKey: "" };

function read(): AuthConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<AuthConfig>;
    return {
      baseUrl: parsed.baseUrl ?? "",
      publicKey: parsed.publicKey ?? "",
      secretKey: parsed.secretKey ?? "",
    };
  } catch {
    return empty;
  }
}

let cache: AuthConfig = read();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function getAuthConfig(): AuthConfig {
  return cache;
}

export function setAuthConfig(next: AuthConfig): void {
  cache = {
    baseUrl: next.baseUrl.replace(/\/+$/, ""),
    publicKey: next.publicKey.trim(),
    secretKey: next.secretKey.trim(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage may be unavailable (private mode); keep in-memory only.
  }
  emit();
}

export function clearAuthConfig(): void {
  cache = empty;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  emit();
}

export function isAuthConfigured(cfg: AuthConfig = cache): boolean {
  return cfg.publicKey.length > 0 && cfg.secretKey.length > 0;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React hook returning the current auth config (re-renders on change). */
export function useAuthConfig(): AuthConfig {
  return useSyncExternalStore(subscribe, getAuthConfig, getAuthConfig);
}
