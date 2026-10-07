import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeValue, encodeValue } from "@tursodatabase/serverless";
import { createLocalDatabase, type LocalDatabase } from "../local";

type WireValue = ReturnType<typeof encodeValue>;
type SqlStatement = {
  sql: string;
  args?: WireValue[];
  named_args?: { name: string; value: WireValue }[];
  want_rows?: boolean;
};
type PipelineRequest = { type: string; sql?: string; stmt?: SqlStatement };
type Payload = {
  baton?: string;
  requests?: PipelineRequest[];
  batch?: { steps: { stmt: SqlStatement; condition?: { type: string } }[] };
};
type Stream = { db: LocalDatabase; autocommit: boolean };

export async function startRemoteTestServer(basePath = "", search = "") {
  const directory = mkdtempSync(join(tmpdir(), "perifuse-remote-"));
  const filename = join(directory, "cloud.turso.db");
  const streams = new Map<string, Stream>();
  const token = "test-token-never-log";
  let sequence = 0;
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const endpoint = requestUrl.pathname.slice(basePath.replace(/\/+$/, "").length);
    if (
      requestUrl.search !== search ||
      !["/v3/pipeline", "/v3/cursor"].some(
        (path) => requestUrl.pathname === `${basePath.replace(/\/+$/, "")}${path}`,
      )
    ) {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end(JSON.stringify({ message: "Unauthorized" }));
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body) as Payload;
      const baton = payload.baton ?? `stream-${++sequence}`;
      let stream = streams.get(baton);
      if (!stream) {
        const db = createLocalDatabase(filename);
        await db.connect();
        stream = { db, autocommit: true };
        streams.set(baton, stream);
      }
      const { db } = stream;
      const updateAutocommit = (sql: string) => {
        if (/^BEGIN\b/i.test(sql.trim())) stream.autocommit = false;
        if (/^(COMMIT|ROLLBACK)\s*;?$/i.test(sql.trim())) stream.autocommit = true;
      };
      if (endpoint === "/v3/pipeline") {
        const results: unknown[] = [];
        let closed = false;
        for (const entry of payload.requests ?? []) {
          try {
            let result: unknown;
            if (entry.type === "get_autocommit")
              result = { type: entry.type, is_autocommit: stream.autocommit };
            else if (entry.type === "close") {
              await db.close();
              streams.delete(baton);
              closed = true;
              result = { type: entry.type };
            } else if (entry.type === "sequence") {
              if (/\bPRAGMA\s+query_only\b/i.test(entry.sql ?? ""))
                throw new Error(
                  "SQL string could not be parsed: unsupported statement: PRAGMA query_only",
                );
              await db.exec(entry.sql!);
              updateAutocommit(entry.sql!);
              result = { type: entry.type };
            } else if (entry.type === "describe") {
              const statement = await db.prepare(entry.sql!);
              result = {
                type: entry.type,
                result: {
                  cols: statement
                    .columns()
                    .map((column) => ({ name: column.name, decltype: column.type })),
                  params: [],
                  is_explain: false,
                  is_readonly:
                    (statement.reader &&
                      !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(entry.sql!.split(";")[0])) ||
                    /^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*$/i.test(entry.sql!),
                },
              };
              statement.close();
            } else throw new Error(`Unsupported pipeline request ${entry.type}`);
            results.push({ type: "ok", response: result });
          } catch (error) {
            results.push({
              type: "error",
              error: {
                message: error instanceof Error ? error.message : "SQL failure",
                code: "SQL_ERROR",
              },
            });
          }
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ baton: closed ? null : baton, results }));
      } else if (endpoint === "/v3/cursor") {
        response.setHeader("content-type", "application/x-ndjson");
        const write = (value: unknown) => response.write(`${JSON.stringify(value)}\n`);
        write({ baton });
        for (const [index, entry] of (payload.batch?.steps ?? []).entries()) {
          if (entry.condition?.type === "is_autocommit" && !stream.autocommit) continue;
          try {
            const statement = await db.prepare(entry.stmt.sql);
            const columns = statement
              .columns()
              .map((column) => ({ name: column.name, decltype: column.type }));
            const parameters = entry.stmt.named_args?.length
              ? [
                  Object.fromEntries(
                    entry.stmt.named_args.map(({ name, value }) => [name, decodeValue(value)]),
                  ),
                ]
              : (entry.stmt.args ?? []).map((value) => decodeValue(value));
            write({ type: "step_begin", step: index, cols: columns });
            let changes = 0;
            let lastInsertRowid: number | bigint | undefined;
            if (statement.reader) {
              if (entry.stmt.want_rows !== false) {
                for (const row of await statement.raw(true).all(...parameters))
                  write({
                    type: "row",
                    row: (row as unknown[]).map((value) => encodeValue(value)),
                  });
              } else await statement.all(...parameters);
            } else {
              const result = await statement.run(...parameters);
              changes = Number(result.changes);
              lastInsertRowid = result.lastInsertRowid;
            }
            statement.close();
            updateAutocommit(entry.stmt.sql);
            write({
              type: "step_end",
              affected_row_count: changes,
              last_insert_rowid: lastInsertRowid?.toString() ?? null,
            });
          } catch (error) {
            write({
              type: "step_error",
              step: index,
              error: {
                message: error instanceof Error ? error.message : "SQL failure",
                code: "SQL_ERROR",
              },
            });
          }
        }
        response.end();
      } else response.writeHead(404).end();
    } catch {
      response.writeHead(500).end(JSON.stringify({ message: "Test protocol failure" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not listen");
  return {
    url: `http://127.0.0.1:${address.port}${basePath}${search}`,
    authToken: token,
    directory,
    requestCount: () => requests,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.all([...streams.values()].map(({ db }) => db.close()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
