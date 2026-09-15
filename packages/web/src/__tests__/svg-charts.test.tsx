import {
  Chart,
  ACTIVITY_CHART_HEIGHT,
  DUAL_AXIS_CHART_MARGIN,
  formatChartCompact,
} from "../../../../vendor/peri-studio/packages/ui/src/components/chart";
import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

describe("Chart activity composed", () => {
  it("uses compact token axis labels and a single shared plot", () => {
    const view = render(() => (
      <Chart.Cartesian
        labels={["2026-01-08", "2026-01-09", "2026-01-10"]}
        height={ACTIVITY_CHART_HEIGHT}
        margin={DUAL_AXIS_CHART_MARGIN}
        formatX={(label) => label.slice(5)}
      >
        <Chart.Bars
          axis="left"
          series={[
            { name: "traces", color: "var(--chart-1)", values: [120, 95, 140] },
            { name: "observations", color: "var(--chart-2)", values: [480, 520, 610], opacity: 0.6 },
          ]}
        />
        <Chart.Line
          axis="right"
          formatY={formatChartCompact}
          series={[
            {
              name: "tokens",
              color: "var(--chart-3)",
              values: [180_000, 210_000, 200_000_000],
            },
          ]}
        />
      </Chart.Cartesian>
    ));

    const svg = view.container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.textContent).toContain("200M");
    expect(svg?.textContent).not.toMatch(/200000k/i);
    expect(svg?.textContent).not.toMatch(/kk/i);
    expect(view.container.querySelectorAll("svg").length).toBe(1);
    expect(svg?.querySelector("polyline")).toBeTruthy();
    expect(svg?.querySelectorAll("rect").length).toBeGreaterThan(0);
  });
});
