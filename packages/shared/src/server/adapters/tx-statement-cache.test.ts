import { expect, it } from "vitest";
import { createLocalDatabase, type LocalExecutor } from "../../db/local";
import { TransactionStatementCache, withTransactionStatementCache } from "./tx-statement-cache";

const GET_TRACE = "SELECT name FROM traces WHERE project_id=? AND id=?";
const UPDATE_TRACE = "UPDATE traces SET name=@name WHERE project_id=@projectId AND id=@id";
const DAILY = "INSERT INTO daily_stats_dirty(project_id,day) SELECT ?,? WHERE ? IS NOT NULL";

/**
 * Emulates the binding memory both drivers keep per statement: named calls only
 * write the parameters that are present and defined (Turso `bindNamedParams`,
 * the `bun:sqlite` layer's named branch), positional calls keep the slots they
 * do not overwrite and reject a binding style switch.
 */
class StubStatement {
  private named = new Map<string, unknown>();
  private slots: unknown[] | null = null;
  private style: "none" | "named" | "positional" = "none";
  closed = false;

  constructor(
    private readonly engine: StubEngine,
    private readonly sql: string,
  ) {}

  async run(...parameters: unknown[]): Promise<{ changes: number; lastInsertRowid: number }> {
    this.bind(parameters);
    this.engine.record("run", this.sql, this.values());
    return { changes: 1, lastInsertRowid: 0 };
  }

  async get(...parameters: unknown[]): Promise<unknown> {
    this.bind(parameters);
    this.engine.record("get", this.sql, this.values());
    return { sql: this.sql, values: this.values() };
  }

  async all(...parameters: unknown[]): Promise<unknown[]> {
    this.bind(parameters);
    this.engine.record("all", this.sql, this.values());
    return [{ sql: this.sql, values: this.values() }];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.engine.closedStatements.push(this);
  }

  private bind(parameters: unknown[]): void {
    if (this.closed) throw new Error("STUB_STATEMENT_CLOSED");
    const single = parameters.length === 1 ? parameters[0] : undefined;
    if (parameters.length === 1 && isPlainObject(single)) {
      if (this.style === "positional")
        throw new TypeError("This statement is already bound with positional parameters");
      this.style = "named";
      for (const key of namedKeys(this.sql)) {
        const value = single[key];
        if (value !== undefined) this.named.set(key, value);
      }
      return;
    }
    if (this.style === "named")
      throw new TypeError("This statement is already bound with named parameters");
    const values = (Array.isArray(single) ? single : parameters).flat(1);
    this.style = "positional";
    this.slots ??= new Array(positionalSlots(this.sql)).fill(null);
    if (values.length > this.slots.length)
      throw new TypeError(
        `Statement expects ${this.slots.length} parameter(s) but received ${values.length}`,
      );
    values.forEach((value, index) => {
      if (value !== undefined) this.slots![index] = value;
    });
  }

  private values(): Record<string, unknown> {
    if (this.style === "named")
      return Object.fromEntries(
        namedKeys(this.sql).map((key) => [key, this.named.has(key) ? this.named.get(key) : null]),
      );
    const slots = this.slots ?? new Array(positionalSlots(this.sql)).fill(null);
    return Object.fromEntries(slots.map((value, index) => [String(index), value]));
  }
}

type Call = { method: "run" | "get" | "all"; sql: string; values: Record<string, unknown> };

/** The uncached driver path: every call prepares a statement, executes it and closes it. */
class StubEngine {
  prepares = 0;
  readonly calls = { run: 0, get: 0, all: 0 };
  readonly log: Call[] = [];
  readonly closedStatements: StubStatement[] = [];

  prepare(sql: string): StubStatement {
    this.prepares += 1;
    return new StubStatement(this, sql);
  }

  record(method: Call["method"], sql: string, values: Record<string, unknown>): void {
    this.calls[method] += 1;
    this.log.push({ method, sql, values });
  }

  async run(sql: string, ...parameters: unknown[]) {
    const statement = this.prepare(sql);
    try {
      return await statement.run(...parameters);
    } finally {
      statement.close();
    }
  }

  async get(sql: string, ...parameters: unknown[]) {
    const statement = this.prepare(sql);
    try {
      return await statement.get(...parameters);
    } finally {
      statement.close();
    }
  }

  async all(sql: string, ...parameters: unknown[]) {
    const statement = this.prepare(sql);
    try {
      return await statement.all(...parameters);
    } finally {
      statement.close();
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const namedKeys = (sql: string) => [
  ...new Set([...sql.matchAll(/@([A-Za-z0-9_]+)/g)].map((match) => match[1])),
];
const positionalSlots = (sql: string) => (sql.match(/\?/g) ?? []).length;

type Caller = Pick<LocalExecutor, "run" | "get" | "all">;

/** One ingestion-shaped round: repeated reads, a named update and a positional write. */
async function workload(caller: Caller, rounds: number): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    const id = `trace-${round % 3}`;
    await caller.get(GET_TRACE, "p", id);
    await caller.run(UPDATE_TRACE, { projectId: "p", id, name: `name-${round}` });
    await caller.get(GET_TRACE, "p", id);
    await caller.run(DAILY, "p", "2026-01-01", "2026-01-01");
  }
}

const lastValues = (engine: StubEngine, method: Call["method"]) =>
  engine.log.filter((call) => call.method === method).at(-1)?.values;

it("reuses one prepared statement per SQL text and binding shape", async () => {
  const uncached = new StubEngine();
  await workload(uncached as unknown as Caller, 10);

  const cached = new StubEngine();
  let closedInsideCallback = -1;
  await withTransactionStatementCache(cached as unknown as LocalExecutor, async (tx) => {
    await workload(tx, 10);
    // Statements outlive single calls (they are reused until the callback ends).
    closedInsideCallback = cached.closedStatements.length;
    expect(cached.prepares).toBe(3);
  });

  // 40 logical calls (20 get + 20 run) over 3 distinct SQL texts.
  expect(uncached.calls).toEqual({ run: 20, get: 20, all: 0 });
  expect(uncached.prepares).toBe(40);
  expect(cached.calls).toEqual({ run: 20, get: 20, all: 0 });
  expect(cached.prepares).toBe(3);
  expect(closedInsideCallback).toBe(0);
  expect(cached.closedStatements).toHaveLength(3);
  expect(cached.closedStatements.every((statement) => statement.closed)).toBe(true);
});

it("rebinds every execution: the second call sees the second values", async () => {
  const engine = new StubEngine();
  await withTransactionStatementCache(engine as unknown as LocalExecutor, async (tx) => {
    await tx.get(GET_TRACE, "p", "first");
    expect(lastValues(engine, "get")).toEqual({ "0": "p", "1": "first" });
    await tx.get(GET_TRACE, "p", "second");
    expect(lastValues(engine, "get")).toEqual({ "0": "p", "1": "second" });
    await tx.run(UPDATE_TRACE, { projectId: "p", id: "first", name: "one" });
    expect(lastValues(engine, "run")).toEqual({ projectId: "p", id: "first", name: "one" });
    await tx.run(UPDATE_TRACE, { projectId: "p", id: "second", name: "two" });
    expect(lastValues(engine, "run")).toEqual({ projectId: "p", id: "second", name: "two" });
  });
  expect(engine.prepares).toBe(2);
});

it("pins the driver binding memory the cache has to work around", async () => {
  const engine = new StubEngine();
  const statement = engine.prepare(GET_TRACE);
  await statement.run("p", "first");
  // The driver keeps the bindings a later call does not overwrite; a reused
  // statement would answer the second call with the first call's id.
  await statement.run("p");
  expect(engine.log.at(-1)?.values).toEqual({ "0": "p", "1": "first" });
  // Mixing named and positional calls on one statement is rejected outright.
  await expect(statement.get({ projectId: "p" })).rejects.toThrow(
    "already bound with positional parameters",
  );
});

it("never keeps a previous value when a named call leaves a parameter undefined", async () => {
  const run = async (caller: Caller) => {
    await caller.get(UPDATE_TRACE, { projectId: "p", id: "trace-1", name: "kept" });
    await caller.get(UPDATE_TRACE, { projectId: "p", id: "trace-1", name: undefined });
  };

  const uncached = new StubEngine();
  await run(uncached as unknown as Caller);
  expect(lastValues(uncached, "get")).toEqual({ projectId: "p", id: "trace-1", name: null });

  const cached = new StubEngine();
  await withTransactionStatementCache(cached as unknown as LocalExecutor, (tx) => run(tx));
  expect(lastValues(cached, "get")).toEqual({ projectId: "p", id: "trace-1", name: null });
  // The undefined call bypasses the cache instead of reusing the bound statement.
  expect(cached.prepares).toBe(2);
});

it("never keeps a previous value when the positional arity changes", async () => {
  const run = async (caller: Caller) => {
    await caller.get(GET_TRACE, "p", "trace-1");
    await caller.get(GET_TRACE, "p");
  };

  const uncached = new StubEngine();
  await run(uncached as unknown as Caller);
  expect(lastValues(uncached, "get")).toEqual({ "0": "p", "1": null });

  const cached = new StubEngine();
  await withTransactionStatementCache(cached as unknown as LocalExecutor, (tx) => run(tx));
  expect(lastValues(cached, "get")).toEqual({ "0": "p", "1": null });
  expect(cached.prepares).toBe(2);
});

it("falls back when the same SQL text switches binding style", async () => {
  const run = async (caller: Caller) => {
    await caller.get(GET_TRACE, { projectId: "p" });
    await caller.get(GET_TRACE, "p", "trace-1");
  };

  const uncached = new StubEngine();
  await run(uncached as unknown as Caller);
  expect(lastValues(uncached, "get")).toEqual({ "0": "p", "1": "trace-1" });

  const cached = new StubEngine();
  await withTransactionStatementCache(cached as unknown as LocalExecutor, (tx) => run(tx));
  // One statement cannot carry both styles; the cache bypasses its entry
  // instead of surfacing the driver's TypeError from a reused statement.
  expect(lastValues(cached, "get")).toEqual({ "0": "p", "1": "trace-1" });
  expect(cached.prepares).toBe(2);
});

it("uses the driver path when the executor cannot prepare", async () => {
  const engine = new StubEngine();
  const withoutPrepare = {
    run: engine.run.bind(engine),
    get: engine.get.bind(engine),
    all: engine.all.bind(engine),
  } as unknown as LocalExecutor;
  await withTransactionStatementCache(withoutPrepare, (tx) => workload(tx, 3));
  expect(engine.calls).toEqual({ run: 6, get: 6, all: 0 });
  expect(engine.prepares).toBe(12);
});

it("disables itself for good when prepare throws", async () => {
  const engine = new StubEngine();
  let attempts = 0;
  const failing = {
    prepare: () => {
      attempts += 1;
      throw new Error("SQLITE_ERROR: prepare failed");
    },
    run: engine.run.bind(engine),
    get: engine.get.bind(engine),
    all: engine.all.bind(engine),
  } as unknown as LocalExecutor;
  await withTransactionStatementCache(failing, (tx) => workload(tx, 4));
  expect(attempts).toBe(1);
  expect(engine.calls).toEqual({ run: 8, get: 8, all: 0 });
});

it("closes and ignores a prepare result that is not a statement", async () => {
  const engine = new StubEngine();
  const closed: string[] = [];
  const invalid = {
    prepare: () => ({ close: () => void closed.push("invalid") }),
    run: engine.run.bind(engine),
    get: engine.get.bind(engine),
    all: engine.all.bind(engine),
  } as unknown as LocalExecutor;
  await withTransactionStatementCache(invalid, (tx) => workload(tx, 2));
  expect(closed).toEqual(["invalid"]);
  expect(engine.calls).toEqual({ run: 4, get: 4, all: 0 });
  expect(engine.prepares).toBe(8);
});

it("closes every statement before the transaction ends, even when the callback throws", async () => {
  const engine = new StubEngine();
  await expect(
    withTransactionStatementCache(engine as unknown as LocalExecutor, async (tx) => {
      await tx.get(GET_TRACE, "p", "trace-1");
      await tx.run(DAILY, "p", "2026-01-01", "2026-01-01");
      throw new Error("INGESTION_FAILED");
    }),
  ).rejects.toThrow("INGESTION_FAILED");
  expect(engine.prepares).toBe(2);
  expect(engine.closedStatements).toHaveLength(2);
  expect(engine.closedStatements.every((statement) => statement.closed)).toBe(true);
});

it("bounds the cache and closes the least recently used statement", async () => {
  const engine = new StubEngine();
  const cache = new TransactionStatementCache(engine as unknown as LocalExecutor, 2);
  try {
    for (const sql of [GET_TRACE, UPDATE_TRACE, DAILY])
      await cache.get(sql, [], () => engine.get(sql));
    expect(cache.size).toBe(2);
    // The first entry was evicted and finalized; the two newer ones are still open.
    expect(engine.closedStatements).toHaveLength(1);
    expect(engine.closedStatements[0].closed).toBe(true);
    await cache.get(GET_TRACE, [], () => engine.get(GET_TRACE));
    expect(engine.prepares).toBe(4);
  } finally {
    await cache.close();
  }
  expect(engine.closedStatements).toHaveLength(4);
});

it("forwards everything it does not cache", async () => {
  const engine = new StubEngine();
  const seen: unknown[] = [];
  const custom = new Proxy(engine as unknown as LocalExecutor, {
    get(target, property) {
      if (property === "exec") return (sql: string) => void seen.push(sql);
      if (property === "marker") return "outside";
      return Reflect.get(target, property);
    },
  });
  await withTransactionStatementCache(custom, async (tx) => {
    await tx.exec("PRAGMA optimize");
    expect((tx as unknown as { marker: string }).marker).toBe("outside");
    await tx.get(GET_TRACE, "p", "trace-1");
  });
  expect(seen).toEqual(["PRAGMA optimize"]);
  expect(engine.calls.get).toBe(1);
});

/**
 * Measured on the default engine (`@tursodatabase/database` 0.8.2): a statement
 * keeps the bindings that a later call does not overwrite. That is the hazard
 * the binding-shape guard exists for — without it, reusing one statement for
 * the second call would answer with the first call's value.
 */
it("documents the driver binding memory the shape guard exists for", async () => {
  const db = createLocalDatabase(":memory:");
  await db.connect();
  try {
    const rows = await db
      .transactionAsync(async (tx) => {
        const statement = await tx.prepare("SELECT @a AS a, @b AS b");
        try {
          const bound = await statement.get({ a: "1", b: "one" });
          const undefinedKey = await statement.get({ a: "2" });
          const rebound = await statement.get({ a: "3", b: "three" });
          return [bound, undefinedKey, rebound];
        } finally {
          statement.close();
        }
      })
      .immediate();
    expect(rows).toEqual([
      { a: "1", b: "one" },
      { a: "2", b: "one" },
      { a: "3", b: "three" },
    ]);
    const positional = await db
      .transactionAsync(async (tx) => {
        const statement = await tx.prepare("SELECT ? AS a, ? AS b");
        try {
          await statement.get("1", "one");
          return await statement.get("2");
        } finally {
          statement.close();
        }
      })
      .immediate();
    // A shorter parameter list keeps the remaining positional slots as well.
    expect(positional).toEqual({ a: "2", b: "one" });
  } finally {
    await db.close();
  }
});

/**
 * A trailing `{ queryTimeout }` is an option, not a binding: the driver strips
 * it before binding, so the shape guard has to strip it too. Otherwise the two
 * calls below look like the same positional shape and the second one would
 * reuse the first one's `b`.
 */
it("does not treat a trailing query-options object as a binding", async () => {
  const db = createLocalDatabase(":memory:");
  await db.connect();
  const sql = "SELECT @a AS a, @b AS b";
  try {
    const rows = await db
      .transactionAsync(async (tx) =>
        withTransactionStatementCache(tx, async (cachedTx) => {
          const first = await cachedTx.get(sql, { a: "1", b: "one" }, { queryTimeout: 5_000 });
          const partial = await cachedTx.get(sql, { a: "2" }, { queryTimeout: 5_000 });
          return [first, partial];
        }),
      )
      .immediate();
    // The second call prepared its own statement, so `b` is unbound (NULL)
    // instead of the first call's value.
    expect(rows).toEqual([
      { a: "1", b: "one" },
      { a: "2", b: null },
    ]);
  } finally {
    await db.close();
  }
});
