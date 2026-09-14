import { MessageHost } from "@peri/ui";
import { fireEvent, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingPage } from "@/pages/onboarding-page";
import { clearProjectContext } from "@/shared/store/project";
import { jsonResponse, mockManageFetch, renderWithProviders } from "@/test/query-test-helpers";

const sampleProjects = [
  {
    id: "proj-1",
    name: "Alpha",
    orgName: "Default Org",
    keyCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

const sampleContext = {
  projectId: "proj-1",
  projectName: "Alpha",
  publicKey: "pk-test",
  secretKey: "sk-test",
};

describe("OnboardingPage", () => {
  beforeEach(() => {
    clearProjectContext();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows loading skeleton while projects load", () => {
    vi.stubGlobal(
      "fetch",
      mockManageFetch({
        projects: () => new Promise(() => jsonResponse(sampleProjects)),
      }),
    );

    const view = renderWithProviders(() => (
      <>
        <OnboardingPage />
        <MessageHost />
      </>
    ));

    expect(view.container.querySelector(".ui-skeleton")).toBeTruthy();
  });

  it("lists projects and activates on click", async () => {
    vi.stubGlobal(
      "fetch",
      mockManageFetch({
        projects: () => jsonResponse(sampleProjects),
        activate: () => jsonResponse(sampleContext),
      }),
    );

    const view = renderWithProviders(() => (
      <>
        <OnboardingPage />
        <MessageHost />
      </>
    ));

    await waitFor(() => {
      expect(view.getByText("Alpha")).toBeTruthy();
    });

    view.getByText("Alpha").click();

    await waitFor(() => {
      expect(localStorage.getItem("peri-fuse-project")).toContain("proj-1");
    });
  });

  it("shows error state with retry", async () => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      mockManageFetch({
        projects: () => {
          attempts += 1;
          if (attempts === 1) {
            return jsonResponse({ message: "Server unavailable" }, { status: 500 });
          }
          return jsonResponse(sampleProjects);
        },
      }),
    );

    const view = renderWithProviders(() => (
      <>
        <OnboardingPage />
        <MessageHost />
      </>
    ));

    await waitFor(() => {
      expect(view.getByText("Couldn't load projects")).toBeTruthy();
    });

    view.getByRole("button", { name: "Retry" }).click();

    await waitFor(() => {
      expect(view.getByText("Alpha")).toBeTruthy();
    });
  });

  it("creates a project then activates", async () => {
    vi.stubGlobal(
      "fetch",
      mockManageFetch({
        projects: () => jsonResponse([]),
        createProject: ({ name }) =>
          jsonResponse({
            id: "proj-new",
            name,
            orgName: "Default Org",
            keyCount: 0,
            createdAt: "2026-01-02T00:00:00.000Z",
          }),
        activate: (projectId) =>
          jsonResponse({
            ...sampleContext,
            projectId,
            projectName: "New Project",
          }),
      }),
    );

    const view = renderWithProviders(() => (
      <>
        <OnboardingPage />
        <MessageHost />
      </>
    ));

    await waitFor(() => {
      expect(view.getByText("No projects yet — create your first one above.")).toBeTruthy();
    });

    const input = view.getByPlaceholderText("Project name…") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "New Project" } });

    view.getByRole("button", { name: "Create" }).click();

    await waitFor(() => {
      expect(localStorage.getItem("peri-fuse-project")).toContain("proj-new");
    });
  });
});
