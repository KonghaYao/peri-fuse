import { describe, expect, it, vi } from "vitest";

// The shared env schema requires CLICKHOUSE_*/S3 vars unless LANGFUSE_MODE is
// "lite". Set it before any module import so the telemetry adapter's logger
// (which imports env) can load in the shared-package test environment.
vi.hoisted(() => {
  process.env.LANGFUSE_MODE = "lite";
});

// liteBuildFilterWhere is pure, but the module imports the telemetry adapter;
// stub it so importing lite-queries has no side effects.
vi.mock("../adapters", () => ({
  getTelemetryDB: vi.fn(),
}));

import {
  BooleanFilter,
  FilterList,
  NullFilter,
  StringFilter,
  StringOptionsFilter,
} from "../queries/clickhouse-sql/clickhouse-filter";
import { liteBuildFilterWhere } from "./lite-queries";

describe("liteBuildFilterWhere — boolean filters", () => {
  it("builds `col = 1` for a true boolean value", () => {
    const { clause, params } = liteBuildFilterWhere(
      new FilterList([
        new BooleanFilter({
          clickhouseTable: "scores",
          field: "value",
          operator: "=",
          value: true,
        }),
      ]),
      "scores",
    );

    expect(clause).toBe("value = @bool0");
    expect(params).toEqual({ bool0: 1 });
  });

  it("builds `col != 0` for a false boolean with the '<>' operator", () => {
    const { clause, params } = liteBuildFilterWhere(
      new FilterList([
        new BooleanFilter({
          clickhouseTable: "scores",
          field: "value",
          operator: "<>",
          value: false,
        }),
      ]),
      "scores",
    );

    expect(clause).toBe("value != @bool0");
    expect(params).toEqual({ bool0: 0 });
  });
});

describe("liteBuildFilterWhere — null filters", () => {
  it("builds `col IS NULL` for the 'is null' operator", () => {
    const { clause, params } = liteBuildFilterWhere(
      new FilterList([
        new NullFilter({
          clickhouseTable: "traces",
          field: "name",
          operator: "is null",
        }),
      ]),
      "traces",
    );

    expect(clause).toBe("name IS NULL");
    expect(params).toEqual({});
  });

  it("builds `col IS NOT NULL` for the 'is not null' operator", () => {
    const { clause } = liteBuildFilterWhere(
      new FilterList([
        new NullFilter({
          clickhouseTable: "traces",
          field: "name",
          operator: "is not null",
        }),
      ]),
      "traces",
    );

    expect(clause).toBe("name IS NOT NULL");
  });
});

describe("liteBuildFilterWhere — json_extract fields", () => {
  it("accepts json_extract expressions whose base column is whitelisted", () => {
    const { clause, params } = liteBuildFilterWhere(
      new FilterList([
        new StringFilter({
          clickhouseTable: "traces",
          field: "json_extract(name, '$.foo')",
          operator: "=",
          value: "bar",
        }),
      ]),
      "traces",
    );

    expect(clause).toBe("json_extract(name, '$.foo') = @str0");
    expect(params).toEqual({ str0: "bar" });
  });

  it("throws for json_extract expressions whose base column is not whitelisted", () => {
    expect(() =>
      liteBuildFilterWhere(
        new FilterList([
          new StringFilter({
            clickhouseTable: "traces",
            field: "json_extract(metadata, '$.foo')",
            operator: "=",
            value: "bar",
          }),
        ]),
        "traces",
      ),
    ).toThrow(/metadata/);
  });
});

describe("liteBuildFilterWhere — unexecutable columns raise 400", () => {
  it("throws for filters on columns outside the whitelist", () => {
    expect(() =>
      liteBuildFilterWhere(
        new FilterList([
          new StringFilter({
            clickhouseTable: "traces",
            field: "metadata",
            operator: "=",
            value: "x",
          }),
        ]),
        "traces",
      ),
    ).toThrow(/metadata/);
  });

  it("throws for observations filters on unsupported traces columns", () => {
    expect(() =>
      liteBuildFilterWhere(
        new FilterList([
          new StringFilter({
            clickhouseTable: "traces",
            field: "release",
            operator: "=",
            value: "x",
          }),
        ]),
        "observations",
      ),
    ).toThrow(/release/);
  });

  it("throws for scores filters on unsupported traces columns", () => {
    expect(() =>
      liteBuildFilterWhere(
        new FilterList([
          new StringFilter({
            clickhouseTable: "traces",
            field: "t.environment",
            operator: "=",
            value: "prod",
          }),
        ]),
        "scores",
      ),
    ).toThrow(/t\.environment/);
  });
});

describe("liteBuildFilterWhere — trace-property subqueries", () => {
  it("lowers observations session_id filters to an EXISTS subquery on traces", () => {
    const { clause, params } = liteBuildFilterWhere(
      new FilterList([
        new StringFilter({
          clickhouseTable: "traces",
          field: "session_id",
          operator: "=",
          value: "sess-1",
        }),
      ]),
      "observations",
    );

    expect(clause).toBe(
      "trace_id IN (SELECT id FROM traces WHERE project_id = @projectId AND session_id = @uf0)",
    );
    expect(params).toEqual({ uf0: "sess-1" });
  });

  it("lowers observations trace_name filters to an EXISTS subquery on traces", () => {
    const { clause } = liteBuildFilterWhere(
      new FilterList([
        new StringFilter({
          clickhouseTable: "traces",
          field: "trace_name",
          operator: "=",
          value: "my-trace",
        }),
      ]),
      "observations",
    );

    expect(clause).toContain("AND name = @uf0");
  });

  it("lowers observations tags filters to a LIKE subquery on traces", () => {
    const { clause, params } = liteBuildFilterWhere(
      new FilterList([
        new StringOptionsFilter({
          clickhouseTable: "traces",
          field: "tags",
          operator: "any of",
          values: ["a"],
        }),
      ]),
      "observations",
    );

    expect(clause).toContain("trace_id IN (SELECT t.id FROM traces t");
    expect(clause).toContain("t.tags LIKE @tag0");
    expect(params.tag0).toBe('%"a"%');
  });

  it("matches prefixed scores user_id filters (t.user_id) via subquery", () => {
    const { clause } = liteBuildFilterWhere(
      new FilterList([
        new StringFilter({
          clickhouseTable: "traces",
          field: "t.user_id",
          operator: "=",
          value: "u-1",
        }),
      ]),
      "scores",
    );

    expect(clause).toBe(
      "trace_id IN (SELECT id FROM traces WHERE project_id = @projectId AND user_id = @uf0)",
    );
  });

  it("matches prefixed scores trace_tags filters (t.tags) via subquery", () => {
    const { clause } = liteBuildFilterWhere(
      new FilterList([
        new StringOptionsFilter({
          clickhouseTable: "traces",
          field: "t.tags",
          operator: "all of",
          values: ["a", "b"],
        }),
      ]),
      "scores",
    );

    expect(clause).toContain("t.tags LIKE @tag0");
    expect(clause).toContain(" AND ");
    expect(clause).toContain("t.tags LIKE @tag1");
  });

  it("lowers prefixed scores trace_name filters (t.name) via subquery", () => {
    const { clause } = liteBuildFilterWhere(
      new FilterList([
        new StringFilter({
          clickhouseTable: "traces",
          field: "t.name",
          operator: "=",
          value: "trace-x",
        }),
      ]),
      "scores",
    );

    expect(clause).toBe(
      "trace_id IN (SELECT id FROM traces WHERE project_id = @projectId AND name = @uf0)",
    );
  });
});

describe("liteBuildFilterWhere — dataset_run_id", () => {
  it("compiles to a constant-false clause (lite has no dataset-run scores)", () => {
    const { clause, params } = liteBuildFilterWhere(
      new FilterList([
        new StringFilter({
          clickhouseTable: "scores",
          field: "dataset_run_id",
          operator: "=",
          value: "run-1",
        }),
      ]),
      "scores",
    );

    expect(clause).toBe("1 = 0");
    expect(params).toEqual({});
  });
});
