import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { formatLatency } from "@/shared/lib/format";

function HelloSolid() {
  const [name] = createSignal("Peri-Fuse");
  return <p>Hello {name()}</p>;
}

describe("solid shell smoke", () => {
  it("renders a basic Solid component", () => {
    const view = render(() => <HelloSolid />);
    expect(view.getByText("Hello Peri-Fuse")).toBeTruthy();
  });

  it("keeps framework-agnostic format helpers", () => {
    expect(formatLatency(0.5)).toBe("500 ms");
  });
});
