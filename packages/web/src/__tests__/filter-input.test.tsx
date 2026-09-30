// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { FilterInput, type FilterInputHandle } from "@/shared/components/filter-input";
import { useTableState } from "@/shared/hooks/use-table-state";

function FilterHarness() {
  const nameRef = useRef<FilterInputHandle>(null);
  const userRef = useRef<FilterInputHandle>(null);
  const state = useTableState<{ name?: string; userId?: string }>({
    filterKeys: ["name", "userId"],
  });
  const location = useLocation();
  return (
    <>
      <FilterInput
        ref={nameRef}
        placeholder="Name"
        value={state.filters.name}
        onCommit={(value) => state.setFilter("name", value)}
      />
      <FilterInput
        ref={userRef}
        placeholder="User"
        value={state.filters.userId}
        onCommit={(value) => state.setFilter("userId", value)}
      />
      <button
        type="button"
        onClick={() =>
          state.setFilters({
            name: nameRef.current?.getValue(),
            userId: userRef.current?.getValue(),
          })
        }
      >
        Search
      </button>
      <button
        type="button"
        onClick={() => {
          nameRef.current?.reset();
          userRef.current?.reset();
          state.clearFilters();
        }}
      >
        Clear
      </button>
      <output data-testid="url">{location.search}</output>
    </>
  );
}

afterEach(cleanup);

describe("filter draft submission", () => {
  it("submits all drafts atomically and resets pagination without losing other URL state", () => {
    render(
      <MemoryRouter initialEntries={["/?page=4&sort=name.asc&peek=trace-a"]}>
        <FilterHarness />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "  chat  " } });
    fireEvent.change(screen.getByPlaceholderText("User"), { target: { value: "alice" } });
    expect(screen.getByTestId("url").textContent).not.toContain("userId");
    fireEvent.click(screen.getByText("Search"));
    const params = new URLSearchParams(screen.getByTestId("url").textContent ?? "");
    expect(params.get("name")).toBe("chat");
    expect(params.get("userId")).toBe("alice");
    expect(params.has("page")).toBe(false);
    expect(params.get("sort")).toBe("name.asc");
    expect(params.get("peek")).toBe("trace-a");
  });

  it("clears uncommitted drafts as well as committed filters", () => {
    render(
      <MemoryRouter initialEntries={["/?name=old&page=3"]}>
        <FilterHarness />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText("User"), { target: { value: "unsubmitted" } });
    fireEvent.click(screen.getByText("Clear"));
    expect((screen.getByPlaceholderText("Name") as HTMLInputElement).value).toBe("");
    expect((screen.getByPlaceholderText("User") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("url").textContent).toBe("");
    fireEvent.click(screen.getByText("Search"));
    expect(screen.getByTestId("url").textContent).toBe("");
  });
});
