/**
 * Turso-shaped Statement compatibility layer for the optional `bun:sqlite`
 * engine. The native handle stays synchronous; every public method is
 * awaitable so Drizzle and the existing callers keep their contract.
 */
import { createDatabaseError } from "./errors";
import type { FifoGate, RetryClock } from "./sqlite-transaction";

export interface QueryOptions {
  queryTimeout?: number;
}

export interface StatementColumn {
  name: string;
  type: string | null;
  column: null;
  table: null;
  database: null;
}

export interface NativeChanges {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

/** Structural view of `bun:sqlite`'s Statement (types are verified in tests). */
export interface NativeStatement {
  readonly columnNames: string[];
  readonly declaredTypes: (string | null)[];
  readonly paramsCount: number;
  values(...bindings: unknown[]): unknown[][];
  run(...bindings: unknown[]): NativeChanges;
  iterate(...bindings: unknown[]): Iterable<unknown> | AsyncIterable<unknown>;
  finalize(): void;
}

export interface StatementOwner {
  gate: FifoGate;
  /** Throws when the connection or transaction can no longer run statements. */
  assertUsable(): void;
  /** Optional async preparation that runs inside the gate (WAL activation). */
  activate?(): Promise<void>;
  /** Registers an accepted operation so the owner can drain it before finishing. */
  track?<T>(promise: Promise<T>): Promise<T>;
  /** Connection-wide change counter used to normalize `run()` results. */
  totalChanges(): number;
  register(statement: SqliteStatement): void;
  unregister(statement: SqliteStatement): void;
}

export type RowMode = "object" | "array" | "pluck";

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

type BindingInput =
  | { kind: "positional"; values: unknown[] }
  | { kind: "named"; entries: [string, unknown][] };

function isQueryOptions(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "queryTimeout")
  );
}

/** Mirrors `@tursodatabase/database-common`'s `splitBindParameters`. */
export function splitArguments(args: unknown[]): { parameters: unknown[]; options?: QueryOptions } {
  if (args.length === 0) return { parameters: [] };
  const last = args[args.length - 1];
  if (args.length > 1 && isQueryOptions(last))
    return {
      parameters: args.length === 2 ? [args[0]] : args.slice(0, -1),
      options: last as QueryOptions,
    };
  return { parameters: args };
}

function expandOneLevel(values: unknown[]): unknown[] {
  const expanded: unknown[] = [];
  for (const value of values) {
    if (Array.isArray(value)) expanded.push(...value);
    else expanded.push(value);
  }
  return expanded;
}

/** Converts a caller-supplied value into something `bun:sqlite` can bind. */
export function normalizeBindingValue(value: unknown): unknown {
  // `undefined` means "keep the value bound by an earlier call".
  if (value === undefined) return undefined;
  if (value === null) return null;
  const type = typeof value;
  if (type === "string") return value;
  if (type === "boolean") return value ? 1 : 0;
  if (type === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("SQLite bindings must be finite numbers; rejections happen here");
    return value;
  }
  if (type === "bigint") {
    const integer = value as bigint;
    if (integer < INT64_MIN || integer > INT64_MAX)
      throw new TypeError("SQLite integers must fit in a signed 64-bit range");
    return integer;
  }
  if (value instanceof Uint8Array)
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  const described = type === "object" ? ((value as object).constructor?.name ?? "object") : type;
  throw new TypeError(`Unsupported SQLite binding: ${described}`);
}

/**
 * Applies `statementArguments` semantics and validates values up front, so a
 * statement can snapshot its arguments before queueing on the execution gate.
 */
export function prepareBindingInput(parameters: unknown[]): BindingInput {
  const value = parameters[0];
  if (
    parameters.length === 1 &&
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Uint8Array)
  ) {
    if (Array.isArray(value))
      return { kind: "positional", values: expandOneLevel(value).map(normalizeBindingValue) };
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError("Named SQLite bindings must be a plain object");
    return {
      kind: "named",
      entries: Object.entries(value).map(([key, entry]) => [key, normalizeBindingValue(entry)]),
    };
  }
  return { kind: "positional", values: expandOneLevel(parameters).map(normalizeBindingValue) };
}

export function convertValue(value: unknown, safeIntegers: boolean): unknown {
  if (typeof value === "bigint") return safeIntegers ? value : Number(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  return value;
}

function convertRecord(value: unknown, safeIntegers: boolean): Record<string, unknown> {
  const row = (value ?? {}) as Record<string, unknown>;
  const entries: [string, unknown][] = Object.keys(row).map((key) => [
    key,
    convertValue(row[key], safeIntegers),
  ]);
  return Object.fromEntries(entries);
}

export class SqliteStatement {
  private mode: RowMode = "object";
  private safe = false;
  private closed = false;
  private bindMode: "none" | "positional" | "named" = "none";
  private positionalSlots: unknown[] | null = null;
  private namedSlots: Map<string, unknown> | null = null;
  private cancelIterator?: () => void;

  constructor(
    private readonly native: NativeStatement,
    private readonly owner: StatementOwner,
    private readonly clock: RetryClock,
  ) {
    owner.register(this);
  }

  get reader(): boolean {
    this.assertOpen();
    return this.native.columnNames.length > 0;
  }

  columns(): StatementColumn[] {
    this.assertOpen();
    let declared: (string | null)[] | undefined;
    // Bun 1.4.2 throws until the statement has been executed once; declared
    // types are therefore unknown (null) before the first execution.
    try {
      declared = this.native.declaredTypes;
    } catch {
      declared = undefined;
    }
    return this.native.columnNames.map((name, index) => ({
      name,
      type: declared?.[index] ?? null,
      column: null,
      table: null,
      database: null,
    }));
  }

  raw(enabled = true): this {
    this.mode = enabled ? "array" : "object";
    return this;
  }

  pluck(enabled = true): this {
    this.mode = enabled ? "pluck" : "object";
    return this;
  }

  safeIntegers(enabled = true): this {
    this.safe = enabled;
    return this;
  }

  async get(...parameters: unknown[]): Promise<unknown> {
    const { parameters: values, options } = splitArguments(parameters);
    const input = prepareBindingInput(values);
    return this.exclusive(input, options, (bindings) => {
      const rows = this.native.values(...bindings);
      const row = rows[0];
      return row === undefined ? undefined : this.convertRow(row);
    });
  }

  async all(...parameters: unknown[]): Promise<unknown[]> {
    const { parameters: values, options } = splitArguments(parameters);
    const input = prepareBindingInput(values);
    return this.exclusive(input, options, (bindings) =>
      this.native.values(...bindings).map((row) => this.convertRow(row)),
    );
  }

  async run(...parameters: unknown[]): Promise<{ changes: number; lastInsertRowid: number }> {
    const { parameters: values, options } = splitArguments(parameters);
    const input = prepareBindingInput(values);
    return this.exclusive(input, options, (bindings) => {
      const before = this.owner.totalChanges();
      const result = this.native.run(...bindings);
      const after = this.owner.totalChanges();
      return {
        changes: after === before ? 0 : Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    });
  }

  iterate(parameters?: unknown, options?: QueryOptions): AsyncGenerator<unknown> {
    this.assertOpen();
    this.owner.assertUsable();
    const input = prepareBindingInput(parameters === undefined ? [] : [parameters]);
    const generator = this.runIteration(input, options);
    this.cancelIterator = () => {
      void generator.return(undefined).catch(() => undefined);
    };
    return generator;
  }

  /** Requests the live iterator to stop; used before COMMIT or close. */
  cancelIteration(): void {
    const cancel = this.cancelIterator;
    this.cancelIterator = undefined;
    cancel?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelIteration();
    this.owner.unregister(this);
    try {
      this.native.finalize();
    } catch {
      /* finalize is idempotent; a closed connection reports failure here */
    }
  }

  /** Marks the statement unusable without touching the native handle. */
  detach(): void {
    this.closed = true;
    this.cancelIteration();
    this.owner.unregister(this);
  }

  private assertOpen(): void {
    if (this.closed) throw createDatabaseError("PERIFUSE_SQLITE_CLOSED", "Statement is closed");
  }

  private convertRow(row: unknown[]): unknown {
    if (this.mode === "pluck") return convertValue(row[0], this.safe);
    if (this.mode === "object") {
      const names = this.native.columnNames;
      return Object.fromEntries(
        names.map((name, index) => [name, convertValue(row[index], this.safe)]),
      );
    }
    return row.map((value) => convertValue(value, this.safe));
  }

  private deadline(options?: QueryOptions): number | undefined {
    const timeout = options?.queryTimeout;
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return undefined;
    return this.clock.now() + timeout;
  }

  private assertDeadline(deadline?: number): void {
    if (deadline !== undefined && this.clock.now() > deadline)
      throw createDatabaseError("SQLITE_INTERRUPT", "SQLite query timed out");
  }

  /**
   * Snapshots bindings before queueing, then merges them into this statement's
   * binding memory inside the gate so queue order decides the final state.
   */
  private exclusive<T>(
    input: BindingInput,
    options: QueryOptions | undefined,
    run: (bindings: unknown[]) => T,
  ): Promise<T> {
    this.assertOpen();
    this.owner.assertUsable();
    const deadline = this.deadline(options);
    const execute = async (): Promise<T> => {
      const release = await this.owner.gate.acquire();
      try {
        this.assertOpen();
        this.owner.assertUsable();
        this.assertDeadline(deadline);
        await this.owner.activate?.();
        return run(this.bindings(input));
      } finally {
        release();
      }
    };
    const promise = execute();
    return this.owner.track ? this.owner.track(promise) : promise;
  }

  private bindings(input: BindingInput): unknown[] {
    if (input.kind === "named") {
      if (this.bindMode === "positional")
        throw new TypeError("This statement is already bound with positional parameters");
      this.bindMode = "named";
      const slots = this.namedSlots ?? new Map<string, unknown>();
      this.namedSlots = slots;
      for (const [key, value] of input.entries) if (value !== undefined) slots.set(key, value);
      if (!slots.size) return [];
      const expanded: Record<string, unknown> = {};
      // Turso binds unprefixed keys to `:name`/`$name`/`@name`; Bun needs the
      // prefix spelled out, and unknown extra keys are ignored.
      for (const [key, value] of slots)
        for (const prefix of [":", "$", "@"]) expanded[`${prefix}${key}`] = value;
      return [expanded];
    }
    if (this.bindMode === "named")
      throw new TypeError("This statement is already bound with named parameters");
    if (!input.values.length && this.bindMode === "none") return [];
    this.bindMode = "positional";
    if (!this.positionalSlots) this.positionalSlots = new Array(this.native.paramsCount).fill(null);
    const slots = this.positionalSlots;
    if (input.values.length > slots.length)
      throw new TypeError(
        `Statement expects ${slots.length} parameter(s) but received ${input.values.length}`,
      );
    input.values.forEach((value, index) => {
      if (value !== undefined) slots[index] = value;
    });
    return slots;
  }

  private async *runIteration(
    input: BindingInput,
    options?: QueryOptions,
  ): AsyncGenerator<unknown> {
    const deadline = this.deadline(options);
    this.owner.assertUsable();
    const release = await this.owner.gate.acquire();
    let nativeIterator: Iterator<unknown> | AsyncIterator<unknown> | undefined;
    try {
      this.assertOpen();
      this.owner.assertUsable();
      this.assertDeadline(deadline);
      const bindings = this.bindings(input);
      if (this.mode !== "object") {
        // Bun cannot restore duplicate columns from an object iterator, so
        // array/pluck iteration is materialized like `all`.
        for (const row of this.native.values(...bindings)) {
          this.assertDeadline(deadline);
          yield this.convertRow(row);
        }
        return;
      }
      const source = this.native.iterate(...bindings);
      nativeIterator = (source as AsyncIterable<unknown>)[Symbol.asyncIterator]
        ? (source as AsyncIterable<unknown>)[Symbol.asyncIterator]()
        : (source as Iterable<unknown>)[Symbol.iterator]();
      let steps = 0;
      for (;;) {
        const step = await nativeIterator.next();
        if (step.done) break;
        yield convertRecord(step.value, this.safe);
        this.assertDeadline(deadline);
        // Yield to the event loop so cancellation and close stay responsive.
        steps += 1;
        if ((steps & 0xff) === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      this.cancelIterator = undefined;
      try {
        await nativeIterator?.return?.();
      } catch {
        /* the native statement may already be finalized by close() */
      }
      release();
    }
  }
}
