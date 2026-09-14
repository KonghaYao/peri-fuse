import { Route, Router } from "@solidjs/router";
import { render } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import type { JSX } from "solid-js";
import { vi } from "vitest";

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(
  ui: () => JSX.Element,
  options?: Parameters<typeof render>[1] & { queryClient?: QueryClient },
) {
  const queryClient = options?.queryClient ?? createTestQueryClient();
  return render(
    () => (
      <QueryClientProvider client={queryClient}>
        <Router root={(props) => <>{props.children}</>}>
          <Route path="*" component={ui} />
        </Router>
      </QueryClientProvider>
    ),
    options,
  );
}

export function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

export function mockManageFetch(handlers: {
  projects?: () => Response | Promise<Response>;
  createProject?: (body: { name: string }) => Response;
  activate?: (projectId: string) => Response;
  keys?: (projectId: string) => Response;
  createKey?: (projectId: string) => Response;
  deleteKey?: (keyId: string) => Response;
}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? `${input.pathname}${input.search}`
          : input.url;
    const url = raw.replace(/^https?:\/\/[^/]+/, "");
    const method =
      init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");

    if (url === "/api/manage/projects" && method === "GET" && handlers.projects) {
      return handlers.projects();
    }
    if (url === "/api/manage/projects" && method === "POST" && handlers.createProject) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { name: string };
      return handlers.createProject(body);
    }
    const activateMatch = url.match(/^\/api\/manage\/projects\/([^/]+)\/activate$/);
    if (activateMatch && method === "POST" && handlers.activate) {
      return handlers.activate(decodeURIComponent(activateMatch[1] ?? ""));
    }
    const keysMatch = url.match(/^\/api\/manage\/projects\/([^/]+)\/keys$/);
    if (keysMatch && method === "GET" && handlers.keys) {
      return handlers.keys(decodeURIComponent(keysMatch[1] ?? ""));
    }
    if (keysMatch && method === "POST" && handlers.createKey) {
      return handlers.createKey(decodeURIComponent(keysMatch[1] ?? ""));
    }
    const deleteMatch = url.match(/^\/api\/manage\/keys\/([^/]+)$/);
    if (deleteMatch && method === "DELETE" && handlers.deleteKey) {
      return handlers.deleteKey(decodeURIComponent(deleteMatch[1] ?? ""));
    }

    return jsonResponse({ message: `Unhandled fetch: ${method} ${url}` }, { status: 404 });
  });
}
