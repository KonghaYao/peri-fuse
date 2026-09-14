import { existsSync } from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type Database from "better-sqlite3";
import { SESSION_SEARCH_WORKER_SOURCE } from "./worker-source";
export class SessionSearchLifecycle {
  private worker: Worker | undefined;
  constructor(private readonly db: Database.Database) {}
  private handleWorkerMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const event = message as { type?: string; error?: unknown };
    if (event.type === "error") {
      try {
        this.db
          .prepare(
            "INSERT INTO search_index_state(project_id,coverage,last_error,updated_at) VALUES('__global__','error',?,datetime('now')) ON CONFLICT(project_id) DO UPDATE SET coverage='error',last_error=excluded.last_error,updated_at=excluded.updated_at",
          )
          .run(String(event.error));
      } catch {
        /* database may already be closed */
      }
    } else if (event.type === "tick-ok" || event.type === "ready") {
      try {
        this.db
          .prepare(
            "UPDATE search_index_state SET last_error=NULL,coverage='ready',updated_at=datetime('now') WHERE project_id='__global__'",
          )
          .run();
      } catch {
        /* database may already be closed */
      }
    }
  }
  start(): void {
    if (this.worker) return;
    this.worker = new Worker(SESSION_SEARCH_WORKER_SOURCE, {
      eval: true,
      workerData: {
        dbPath: this.db.name,
        indexerPath: existsSync(path.join(__dirname, "indexer.js"))
          ? path.join(__dirname, "indexer.js")
          : existsSync(path.join(__dirname, "src/server/session-search/indexer.js"))
            ? path.join(__dirname, "src/server/session-search/indexer.js")
            : path.join(process.cwd(), "dist/src/server/session-search/indexer.js"),
        backfillPath: existsSync(path.join(__dirname, "backfill.js"))
          ? path.join(__dirname, "backfill.js")
          : existsSync(path.join(__dirname, "src/server/session-search/backfill.js"))
            ? path.join(__dirname, "src/server/session-search/backfill.js")
            : path.join(process.cwd(), "dist/src/server/session-search/backfill.js"),
        betterSqlitePath: require.resolve("better-sqlite3"),
      },
    });
    this.worker.on("message", (message) => this.handleWorkerMessage(message));
    this.worker.on("error", (error) => {
      this.handleWorkerMessage({ type: "error", error });
      this.worker = undefined;
    });
  }
  async stop(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      worker.once("exit", finish);
      const timer = setTimeout(() => {
        void worker.terminate().finally(finish);
      }, 2000);
      worker.once("exit", () => clearTimeout(timer));
      worker.postMessage("stop");
    });
  }
}

export function startSessionSearch(db: Database.Database): SessionSearchLifecycle {
  const lifecycle = new SessionSearchLifecycle(db);
  lifecycle.start();
  return lifecycle;
}
