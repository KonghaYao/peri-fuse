import { MessageHost, message } from "@peri/ui";
import { fireEvent, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@/pages/settings-page";
import { clearProjectContext, setProjectContext } from "@/shared/store/project";
import { jsonResponse, mockManageFetch, renderWithProviders } from "@/test/query-test-helpers";

const activeContext = {
  projectId: "proj-1",
  projectName: "Alpha",
  publicKey: "pk-active",
  secretKey: "sk-active",
};

const sampleKeys = [
  {
    id: "key-1",
    publicKey: "pk-list-1",
    displaySecretKey: "sk-...abcd",
    note: "web-ui",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
  },
];

describe("SettingsPage", () => {
  beforeEach(() => {
    clearProjectContext();
    localStorage.clear();
    setProjectContext(activeContext);
    vi.mocked(message.success).mockClear();
    vi.mocked(message.error).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows loading then lists API keys", async () => {
    vi.stubGlobal(
      "fetch",
      mockManageFetch({
        keys: () => jsonResponse(sampleKeys),
      }),
    );

    const view = renderWithProviders(() => (
      <>
        <SettingsPage />
        <MessageHost />
      </>
    ));

    await waitFor(() => {
      expect(view.getByText("pk-list-1")).toBeTruthy();
    });
  });

  it("shows empty state when no keys exist", async () => {
    vi.stubGlobal(
      "fetch",
      mockManageFetch({
        keys: () => jsonResponse([]),
      }),
    );

    const view = renderWithProviders(() => (
      <>
        <SettingsPage />
        <MessageHost />
      </>
    ));

    await waitFor(() => {
      expect(view.getByText("No API keys yet. Create one to start ingesting data.")).toBeTruthy();
    });
  });

  it("creates a key and opens the secret dialog", async () => {
    const fetchMock = mockManageFetch({
      keys: () => jsonResponse([]),
      createKey: () =>
        jsonResponse({
          id: "key-new",
          publicKey: "pk-new",
          secretKey: "sk-new-secret",
          displaySecretKey: "sk-...new",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = renderWithProviders(() => (
      <>
        <SettingsPage />
        <MessageHost />
      </>
    ));

    await waitFor(() => {
      expect(view.getByRole("button", { name: "Create new key" })).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: "Create new key" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
      expect(message.success).toHaveBeenCalledWith("API key created");
      expect(view.getByTestId("dialog")).toBeTruthy();
      expect(view.getByText("sk-new-secret")).toBeTruthy();
    });
  });

  it("shows error state with retry for key list", async () => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      mockManageFetch({
        keys: () => {
          attempts += 1;
          if (attempts === 1) {
            return jsonResponse({ message: "Failed" }, { status: 500 });
          }
          return jsonResponse(sampleKeys);
        },
      }),
    );

    const view = renderWithProviders(() => (
      <>
        <SettingsPage />
        <MessageHost />
      </>
    ));

    await waitFor(() => {
      expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
    });

    view.getByRole("button", { name: "Retry" }).click();

    await waitFor(() => {
      expect(view.getByText("pk-list-1")).toBeTruthy();
    });
  });
});
