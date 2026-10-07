// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectBootstrap } from "@/shared/components/project-bootstrap";
import type { Project } from "@/shared/lib/types";
import {
  clearProjectContext,
  getProjectContext,
  setProjectContext,
  useProjectContext,
} from "@/shared/store/project";
import { createBrowserStorage } from "./browser-storage";

const defaultProject: Project = {
  id: "default-project",
  name: "Default Project",
  orgName: "Default Organization",
  keyCount: 1,
  createdAt: "2026-10-07T00:00:00.000Z",
};
const customProject: Project = { ...defaultProject, id: "custom-project", name: "Custom Project" };
const clients: QueryClient[] = [];
let projects: Project[];
let listFailures: number;
let activationFailures: number;
let requests: string[];

function ActiveProject() {
  const context = useProjectContext();
  return <div data-testid="active-project">{context?.projectName ?? "Empty project"}</div>;
}

function renderBootstrap() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  return render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <ProjectBootstrap>
          <ActiveProject />
        </ProjectBootstrap>
      </QueryClientProvider>
    </StrictMode>,
  );
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createBrowserStorage());
  clearProjectContext();
  localStorage.clear();
  projects = [customProject, defaultProject];
  requests = [];
  listFailures = 0;
  activationFailures = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (resource: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push(`${method} ${resource}`);
      let body: unknown;
      let status = 200;
      if (resource === "/api/manage/projects" && method === "GET") {
        if (listFailures > 0) {
          listFailures--;
          status = 503;
          body = { message: "Projects unavailable" };
        } else body = projects;
      } else if (resource === "/api/manage/projects" && method === "POST") {
        expect(JSON.parse(String(init?.body))).toEqual({ name: "Default Project" });
        projects = [defaultProject];
        body = defaultProject;
        status = 201;
      } else if (resource.endsWith("/activate")) {
        if (activationFailures > 0) {
          activationFailures--;
          status = 503;
          body = { message: "Activation unavailable" };
        } else {
          const projectId = resource.split("/")[4];
          const project = projects.find((candidate) => candidate.id === projectId);
          if (!project) throw new Error("Unexpected project activation");
          body = {
            projectId,
            projectName: project.name,
            publicKey: "pk-test",
            secretKey: "sk-test",
          };
        }
      } else throw new Error(`Unexpected request ${resource}`);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  clearProjectContext();
  vi.unstubAllGlobals();
});

describe("automatic project initialization", () => {
  it("activates Default Project once before showing the application in StrictMode", async () => {
    renderBootstrap();
    expect(screen.getByRole("status").textContent).toContain("Opening your project");
    expect(screen.queryByTestId("active-project")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("active-project").textContent).toBe("Default Project"),
    );
    expect(requests).toEqual([
      "GET /api/manage/projects",
      "POST /api/manage/projects/default-project/activate",
    ]);
    expect(JSON.parse(localStorage.getItem("peri-fuse-project") ?? "null")).toEqual(
      getProjectContext(),
    );
    expect(getProjectContext()?.secretKey).toBe("sk-test");
  });

  it("preserves an existing project choice and refreshes its name", async () => {
    setProjectContext({
      projectId: customProject.id,
      projectName: "Old name",
      publicKey: "pk",
      secretKey: "sk",
    });
    renderBootstrap();
    await waitFor(() =>
      expect(screen.getByTestId("active-project").textContent).toBe("Custom Project"),
    );
    expect(requests).toEqual(["GET /api/manage/projects"]);
    expect(getProjectContext()?.secretKey).toBe("sk");
  });

  it("replaces a deleted or stale stored project with Default Project", async () => {
    setProjectContext({
      projectId: "deleted-project",
      projectName: "Deleted",
      publicKey: "pk",
      secretKey: "sk",
    });
    renderBootstrap();
    await waitFor(() =>
      expect(screen.getByTestId("active-project").textContent).toBe("Default Project"),
    );
    expect(getProjectContext()?.projectId).toBe(defaultProject.id);
  });

  it("creates and activates Default Project when the server has no projects", async () => {
    projects = [];
    renderBootstrap();
    await waitFor(() =>
      expect(screen.getByTestId("active-project").textContent).toBe("Default Project"),
    );
    expect(requests).toEqual([
      "GET /api/manage/projects",
      "POST /api/manage/projects",
      "POST /api/manage/projects/default-project/activate",
    ]);
  });

  it("uses an existing project when no Default Project is present", async () => {
    projects = [customProject];
    renderBootstrap();
    await waitFor(() =>
      expect(screen.getByTestId("active-project").textContent).toBe("Custom Project"),
    );
    expect(requests).not.toContain("POST /api/manage/projects");
  });

  it.each(["list", "activation"])(
    "offers retry without showing an empty project after %s failure",
    async (failure) => {
      if (failure === "list") listFailures = 1;
      else activationFailures = 1;
      renderBootstrap();
      await screen.findByRole("alert");
      expect(screen.queryByTestId("active-project")).toBeNull();
      expect(getProjectContext()).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() =>
        expect(screen.getByTestId("active-project").textContent).toBe("Default Project"),
      );
    },
  );
});
