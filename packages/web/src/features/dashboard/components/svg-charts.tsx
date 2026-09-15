/**
 * Lightweight SVG chart primitives (no charting library).
 */

import { type Component, For, type JSX } from "solid-js";
import {
  bandSlot,
  type ChartMargin,
  DEFAULT_MARGIN,
  describeArc,
  HBAR_MARGIN,
  linearScale,
  niceMax,
  polylinePoints,
} from "../chart-utils";

const GRID_COLOR = "var(--line-subtle)";
const TICK_COLOR = "var(--fg-tertiary)";

function ChartSvg(props: { height: number; children: JSX.Element; class?: string }) {
  return (
    <svg
      viewBox={`0 0 640 ${props.height}`}
      class={props.class ?? "h-full w-full"}
      role="img"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

function YAxisTicks(props: {
  ticks: number[];
  scale: (value: number) => number;
  format: (value: number) => string;
  x: number;
}) {
  return (
    <For each={props.ticks}>
      {(tick) => (
        <text
          x={props.x - 6}
          y={props.scale(tick)}
          text-anchor="end"
          dominant-baseline="middle"
          fill={TICK_COLOR}
          font-size="11"
        >
          {props.format(tick)}
        </text>
      )}
    </For>
  );
}

function GridLines(props: {
  ticks: number[];
  scale: (value: number) => number;
  left: number;
  right: number;
}) {
  return (
    <For each={props.ticks}>
      {(tick) => (
        <line
          x1={props.left}
          x2={props.right}
          y1={props.scale(tick)}
          y2={props.scale(tick)}
          stroke={GRID_COLOR}
          stroke-dasharray="3 3"
          stroke-opacity="0.35"
        />
      )}
    </For>
  );
}

export const VerticalBarChart: Component<{
  labels: string[];
  series: Array<{ key: string; name: string; color: string; values: number[] }>;
  height?: number;
  margin?: ChartMargin;
  formatY?: (value: number) => string;
  formatX?: (label: string) => string;
}> = (props) => {
  const height = () => props.height ?? 256;
  const margin = () => props.margin ?? DEFAULT_MARGIN;
  const innerWidth = () => 640 - margin().left - margin().right;
  const innerHeight = () => height() - margin().top - margin().bottom;
  const maxValue = () => niceMax(Math.max(0, ...props.series.flatMap((s) => s.values)));
  const yScale = () => linearScale(0, maxValue(), margin().top + innerHeight(), margin().top);
  const ticks = () => [0, maxValue() / 2, maxValue()];
  const formatY = (v: number) => props.formatY?.(v) ?? String(Math.round(v));
  const formatX = (label: string) => props.formatX?.(label) ?? label;

  return (
    <ChartSvg height={height()}>
      <GridLines
        ticks={ticks()}
        scale={yScale()}
        left={margin().left}
        right={640 - margin().right}
      />
      <YAxisTicks ticks={ticks()} scale={yScale()} format={formatY} x={margin().left} />
      <For each={props.labels}>
        {(label, labelIndex) => {
          const slot = () => bandSlot(labelIndex(), props.labels.length, innerWidth());
          const groupWidth = () => slot().width / Math.max(props.series.length, 1);
          return (
            <>
              <text
                x={margin().left + slot().x + slot().width / 2}
                y={height() - 8}
                text-anchor="middle"
                fill={TICK_COLOR}
                font-size="11"
              >
                {formatX(label)}
              </text>
              <For each={props.series}>
                {(serie, serieIndex) => {
                  const value = () => serie.values[labelIndex()] ?? 0;
                  const barX = () => margin().left + slot().x + serieIndex() * groupWidth();
                  const barHeight = () => margin().top + innerHeight() - yScale()(value());
                  return (
                    <rect
                      x={barX()}
                      y={yScale()(value())}
                      width={Math.max(groupWidth() * 0.9, 1)}
                      height={Math.max(barHeight(), 0)}
                      fill={serie.color}
                      fill-opacity={serie.key === "observations" ? 0.6 : 0.85}
                      rx="2"
                    />
                  );
                }}
              </For>
            </>
          );
        }}
      </For>
    </ChartSvg>
  );
};

export const LineOverlayChart: Component<{
  labels: string[];
  values: number[];
  color: string;
  height?: number;
  margin?: ChartMargin;
  formatY?: (value: number) => string;
}> = (props) => {
  const height = () => props.height ?? 256;
  const margin = () => props.margin ?? { ...DEFAULT_MARGIN, right: 56 };
  const innerWidth = () => 640 - margin().left - margin().right;
  const innerHeight = () => height() - margin().top - margin().bottom;
  const maxValue = () => niceMax(Math.max(0, ...props.values));
  const yScale = () => linearScale(0, maxValue(), margin().top + innerHeight(), margin().top);
  const xAt = (index: number) => {
    const slot = bandSlot(index, props.labels.length, innerWidth());
    return margin().left + slot.x + slot.width / 2;
  };

  return (
    <ChartSvg height={height()} class="pointer-events-none absolute inset-0">
      <polyline
        fill="none"
        stroke={props.color}
        stroke-width="2"
        points={polylinePoints(props.values, xAt, yScale())}
      />
      <YAxisTicks
        ticks={[0, maxValue()]}
        scale={yScale()}
        format={(v) => props.formatY?.(v) ?? String(v)}
        x={640 - margin().right + 40}
      />
    </ChartSvg>
  );
};

export const ActivityComposedChart: Component<{
  labels: string[];
  traces: number[];
  observations: number[];
  tokens: number[];
  height?: number;
}> = (props) => {
  const height = () => props.height ?? 320;
  return (
    <div class="relative h-320 w-full">
      <VerticalBarChart
        height={height()}
        labels={props.labels}
        formatX={(label) => label.slice(5)}
        series={[
          { key: "traces", name: "traces", color: "var(--chart-1)", values: props.traces },
          {
            key: "observations",
            name: "observations",
            color: "var(--chart-2)",
            values: props.observations,
          },
        ]}
      />
      <LineOverlayChart
        height={height()}
        labels={props.labels}
        values={props.tokens}
        color="var(--chart-3)"
        formatY={(v) => `${Math.round(v / 1000)}k`}
      />
      <div class="mt-8 flex flex-wrap gap-16 text-xs text-fg-tertiary">
        <span class="inline-flex items-center gap-6">
          <span class="h-8 w-8 rounded-sm bg-[var(--chart-1)]" /> traces
        </span>
        <span class="inline-flex items-center gap-6">
          <span class="h-8 w-8 rounded-sm bg-[var(--chart-2)]" /> observations
        </span>
        <span class="inline-flex items-center gap-6">
          <span class="h-10 w-10 rounded-full bg-[var(--chart-3)]" /> tokens
        </span>
      </div>
    </div>
  );
};

export const MultiLineChart: Component<{
  labels: string[];
  series: Array<{ name: string; color: string; values: number[] }>;
  height?: number;
  formatY?: (value: number) => string;
  yDomain?: [number, number];
}> = (props) => {
  const height = () => props.height ?? 256;
  const margin = DEFAULT_MARGIN;
  const innerWidth = 640 - margin.left - margin.right;
  const innerHeight = height() - margin.top - margin.bottom;
  const maxValue = () => {
    if (props.yDomain) return props.yDomain[1];
    return niceMax(Math.max(0, ...props.series.flatMap((s) => s.values)));
  };
  const minValue = () => props.yDomain?.[0] ?? 0;
  const yScale = linearScale(minValue(), maxValue(), margin.top + innerHeight, margin.top);
  const xAt = (index: number) => {
    const slot = bandSlot(index, props.labels.length, innerWidth);
    return margin.left + slot.x + slot.width / 2;
  };
  const ticks = [minValue(), (minValue() + maxValue()) / 2, maxValue()];
  const formatY = (v: number) => props.formatY?.(v) ?? String(v);

  return (
    <div>
      <ChartSvg height={height()}>
        <GridLines ticks={ticks} scale={yScale} left={margin.left} right={640 - margin.right} />
        <YAxisTicks ticks={ticks} scale={yScale} format={formatY} x={margin.left} />
        <For each={props.labels}>
          {(label, index) => (
            <text
              x={xAt(index())}
              y={height() - 8}
              text-anchor="middle"
              fill={TICK_COLOR}
              font-size="11"
            >
              {label.slice(5)}
            </text>
          )}
        </For>
        <For each={props.series}>
          {(serie) => (
            <polyline
              fill="none"
              stroke={serie.color}
              stroke-width="2"
              points={polylinePoints(serie.values, xAt, yScale)}
            />
          )}
        </For>
      </ChartSvg>
      <div class="mt-8 flex flex-wrap gap-16 text-xs text-fg-tertiary">
        <For each={props.series}>
          {(serie) => (
            <span class="inline-flex items-center gap-6">
              <span class="h-2 w-12 rounded-full" style={{ background: serie.color }} />
              {serie.name}
            </span>
          )}
        </For>
      </div>
    </div>
  );
};

export const SingleBarChart: Component<{
  labels: string[];
  values: number[];
  color: string;
  height?: number;
}> = (props) => (
  <VerticalBarChart
    height={props.height ?? 256}
    labels={props.labels}
    formatX={(label) => label.slice(5)}
    series={[{ key: "value", name: "value", color: props.color, values: props.values }]}
  />
);

export const HorizontalBarChart: Component<{
  labels: string[];
  series: Array<{ name: string; color: string; values: number[] }>;
  height?: number;
  formatX?: (value: number) => string;
}> = (props) => {
  const height = () => props.height ?? 256;
  const margin = HBAR_MARGIN;
  const innerWidth = 640 - margin.left - margin.right;
  const innerHeight = height() - margin.top - margin.bottom;
  const maxValue = () => niceMax(Math.max(0, ...props.series.flatMap((s) => s.values)));
  const xScale = linearScale(0, maxValue(), margin.left, margin.left + innerWidth);
  const rowHeight = () => innerHeight / Math.max(props.labels.length, 1);
  const barHeight = () => Math.min(14, rowHeight() * 0.35);
  const formatX = (v: number) => props.formatX?.(v) ?? String(Math.round(v));

  return (
    <div>
      <ChartSvg height={height()}>
        <For each={props.labels}>
          {(label, rowIndex) => {
            const yCenter = () => margin.top + rowIndex() * rowHeight() + rowHeight() / 2;
            return (
              <>
                <text
                  x={margin.left - 8}
                  y={yCenter()}
                  text-anchor="end"
                  dominant-baseline="middle"
                  fill={TICK_COLOR}
                  font-size="11"
                >
                  {label.length > 18 ? `${label.slice(0, 16)}…` : label}
                </text>
                <For each={props.series}>
                  {(serie, serieIndex) => {
                    const value = () => serie.values[rowIndex()] ?? 0;
                    const offset = () =>
                      (serieIndex() - (props.series.length - 1) / 2) * barHeight();
                    return (
                      <rect
                        x={margin.left}
                        y={yCenter() + offset() - barHeight() / 2}
                        width={Math.max(xScale(value()) - margin.left, 0)}
                        height={barHeight()}
                        fill={serie.color}
                        rx="3"
                      />
                    );
                  }}
                </For>
              </>
            );
          }}
        </For>
      </ChartSvg>
      <ShowLegend series={props.series} />
    </div>
  );
};

function ShowLegend(props: { series: Array<{ name: string; color: string }> }) {
  return (
    <div class="mt-8 flex flex-wrap gap-16 text-xs text-fg-tertiary">
      <For each={props.series}>
        {(serie) => (
          <span class="inline-flex items-center gap-6">
            <span class="h-8 w-8 rounded-sm" style={{ background: serie.color }} />
            {serie.name}
          </span>
        )}
      </For>
    </div>
  );
}

export const DonutChart: Component<{
  segments: Array<{ label: string; value: number; color: string; opacity?: number }>;
  height?: number;
}> = (props) => {
  const height = () => props.height ?? 256;
  const cx = 320;
  const cy = height() / 2 - 8;
  const outer = 88;
  const inner = 56;
  const total = () => props.segments.reduce((sum, s) => sum + s.value, 0);
  const arcs = () => {
    let cursor = 0;
    return props.segments.map((segment) => {
      const start = (cursor / Math.max(total(), 1)) * 360;
      cursor += segment.value;
      const end = (cursor / Math.max(total(), 1)) * 360;
      return { ...segment, start, end };
    });
  };

  return (
    <div class="flex flex-col items-center gap-16 sm:flex-row sm:items-center sm:justify-center">
      <ChartSvg height={height()} class="h-224 w-full max-w-xs">
        <For each={arcs()}>
          {(arc) => (
            <path
              d={describeArc(cx, cy, outer, inner, arc.start, Math.max(arc.end - 0.4, arc.start))}
              fill={arc.color}
              fill-opacity={arc.opacity ?? 0.9}
            />
          )}
        </For>
      </ChartSvg>
      <ul class="flex flex-wrap justify-center gap-12 text-xs text-fg-secondary">
        <For each={props.segments}>
          {(segment) => (
            <li class="inline-flex items-center gap-6">
              <span
                class="h-8 w-8 rounded-full"
                style={{ background: segment.color, opacity: segment.opacity ?? 0.9 }}
              />
              {segment.label}
            </li>
          )}
        </For>
      </ul>
    </div>
  );
};
