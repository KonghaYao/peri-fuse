import { describe, expect, it } from "vitest";
import { dayTick } from "@/features/dashboard/chart-utils";

describe("chart-utils", () => {
  it("formats day ticks compactly", () => {
    expect(dayTick("2026-01-15")).toBe("01-15");
  });
});
