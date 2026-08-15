import { describe, expect, it } from "vitest";

import { BooleanFilter, NullFilter, StringFilter } from "./clickhouse-filter";
import { createFilterFromFilterState } from "./factory";

// Simulated uiColumnDefinitions (the shape used by the table mappings).
const columnMapping = [
  {
    uiTableId: "name",
    uiTableName: "Name",
    clickhouseTableName: "observations",
    clickhouseSelect: "name",
    queryPrefix: "o",
  },
  {
    uiTableId: "metadata",
    uiTableName: "Metadata",
    clickhouseTableName: "observations",
    clickhouseSelect: 'o."metadata"',
    queryPrefix: "o",
  },
  {
    uiTableId: "booleanValue",
    uiTableName: "Boolean Value",
    clickhouseTableName: "scores",
    clickhouseSelect: "boolean_value",
    queryPrefix: "s",
  },
];

describe("createFilterFromFilterState", () => {
  it("builds a BooleanFilter for the boolean type with '=' operator", () => {
    const filters = createFilterFromFilterState(
      [{ column: "booleanValue", type: "boolean", operator: "=", value: true }],
      columnMapping,
    );

    expect(filters).toHaveLength(1);
    const f = filters[0];
    expect(f).toBeInstanceOf(BooleanFilter);
    expect(f.field).toBe("boolean_value");
    expect(f.operator).toBe("=");
    expect(f.value).toBe(true);
    expect(f.clickhouseTable).toBe("scores");
  });

  it("keeps the '<>' operator and falsy value for boolean filters", () => {
    const filters = createFilterFromFilterState(
      [{ column: "booleanValue", type: "boolean", operator: "<>", value: false }],
      columnMapping,
    );

    const f = filters[0];
    expect(f).toBeInstanceOf(BooleanFilter);
    expect(f.operator).toBe("<>");
    expect(f.value).toBe(false);
  });

  it("defaults the boolean operator to '=' when omitted", () => {
    const filters = createFilterFromFilterState(
      [{ column: "booleanValue", type: "boolean", value: true }],
      columnMapping,
    );

    expect(filters[0].operator).toBe("=");
  });

  it("builds a NullFilter for the null type with 'is null' operator", () => {
    const filters = createFilterFromFilterState(
      [{ column: "metadata", type: "null", operator: "is null" }],
      columnMapping,
    );

    expect(filters).toHaveLength(1);
    const f = filters[0];
    expect(f).toBeInstanceOf(NullFilter);
    expect(f.field).toBe('o."metadata"');
    expect(f.operator).toBe("is null");
    expect(f.value).toBeUndefined();
  });

  it("keeps the 'is not null' operator for null filters", () => {
    const filters = createFilterFromFilterState(
      [{ column: "metadata", type: "null", operator: "is not null" }],
      columnMapping,
    );

    expect(filters[0].operator).toBe("is not null");
  });

  it("defaults the null operator to 'is null' when omitted", () => {
    const filters = createFilterFromFilterState(
      [{ column: "metadata", type: "null" }],
      columnMapping,
    );

    expect(filters[0].operator).toBe("is null");
  });

  it("resolves stringObject with a key to a json_extract expression", () => {
    const filters = createFilterFromFilterState(
      [
        {
          column: "metadata",
          type: "stringObject",
          key: "foo",
          operator: "=",
          value: "bar",
        },
      ],
      columnMapping,
    );

    expect(filters).toHaveLength(1);
    const f = filters[0];
    expect(f).toBeInstanceOf(StringFilter);
    expect(f.field).toBe("json_extract(metadata, '$.foo')");
    expect(f.operator).toBe("=");
    expect(f.value).toBe("bar");
  });

  it("supports nested and $-prefixed keys without duplicating the prefix", () => {
    const nested = createFilterFromFilterState(
      [{ column: "metadata", type: "stringObject", key: "a.b", value: "x" }],
      columnMapping,
    );
    expect(nested[0].field).toBe("json_extract(metadata, '$.a.b')");

    const prefixed = createFilterFromFilterState(
      [{ column: "metadata", type: "stringObject", key: "$.a", value: "x" }],
      columnMapping,
    );
    expect(prefixed[0].field).toBe("json_extract(metadata, '$.a')");
  });

  it("escapes single quotes in json path keys", () => {
    const filters = createFilterFromFilterState(
      [{ column: "metadata", type: "stringObject", key: "a'b", value: "x" }],
      columnMapping,
    );

    expect(filters[0].field).toBe("json_extract(metadata, '$.a''b')");
  });

  it("keeps the plain column for stringObject without a key", () => {
    const filters = createFilterFromFilterState(
      [{ column: "metadata", type: "stringObject", value: "x" }],
      columnMapping,
    );

    const f = filters[0];
    expect(f).toBeInstanceOf(StringFilter);
    expect(f.field).toBe('o."metadata"');
  });

  it("throws InvalidRequestError for filters whose column has no mapping", () => {
    expect(() =>
      createFilterFromFilterState(
        [{ column: "nonexistent", type: "string", value: "x" }],
        columnMapping,
      ),
    ).toThrow(/nonexistent/);
  });

  it("still builds filters for the pre-existing types", () => {
    const filters = createFilterFromFilterState(
      [
        { column: "name", type: "string", operator: "=", value: "my-obs" },
        { column: "name", type: "stringOptions", value: ["a", "b"] },
      ],
      columnMapping,
    );

    expect(filters).toHaveLength(2);
    expect(filters[0]).toBeInstanceOf(StringFilter);
    expect(filters[0].field).toBe("name");
    expect(filters[1].values).toEqual(["a", "b"]);
  });
});
