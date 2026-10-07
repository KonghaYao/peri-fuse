import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { decodeIoRow } from "../server/adapters/io-compression";
import { openLocalDatabase } from "./local";

const root = resolve(__dirname, "../../../..");
const script = join(root, "scripts/migrate-legacy-db.sh");
const directories: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "perifuse-migration-test-"));
  directories.push(path);
  return path;
}
function sqlite(filename: string, code: string) {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "-e",
      `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);${code};db.close();`,
      filename,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
}
async function migrate(
  source: string,
  target: string,
  args: string[] = [],
  stopAfterCommit: boolean | "SIGKILL" = false,
) {
  const child = spawn("bash", [script, "--source-dir", source, "--target-dir", target, ...args], {
    env: {
      ...process.env,
      NODE_BINARY: process.execPath,
      TURSO_DATABASE_URL: "https://must-not-connect.invalid",
      TURSO_AUTH_TOKEN: "must-not-use",
    },
  });
  children.push(child);
  let output = "";
  let interrupted = false;
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (stopAfterCommit && !interrupted && /traces: \d+\/\d+ rows/.test(output)) {
      interrupted = true;
      child.kill(stopAfterCommit === "SIGKILL" ? "SIGKILL" : "SIGTERM");
    }
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return new Promise<{ status: number | null; output: string }>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (status) => resolveResult({ status, output }));
  });
}
function traces(source: string, count = 3) {
  sqlite(
    join(source, "telemetry.db"),
    `db.exec("CREATE TABLE traces(id TEXT,project_id TEXT,timestamp TEXT,input BLOB,input_codec INTEGER,input_raw_size INTEGER,PRIMARY KEY(project_id,id)); BEGIN");const insert=db.prepare('INSERT INTO traces(rowid,id,project_id,timestamp,input,input_codec,input_raw_size) VALUES(?,?,?,?,?,?,?)');for(let index=0;index<${count};index++)insert.run(index*3+1,'trace-'+index,index%2?'project-b':'project-a','2026-10-06 00:00:00','legacyneedle '+('payload '.repeat(100)),0,813);db.exec('COMMIT')`,
  );
}
const hashFile = (filename: string) =>
  createHash("sha256").update(readFileSync(filename)).digest("hex");

afterEach(async () => {
  await Promise.all(
    children.splice(0).map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      return new Promise<void>((resolveExit) => {
        child.once("exit", () => resolveExit());
        child.kill("SIGTERM");
      });
    }),
  );
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("legacy SQLite to embedded Turso migration", () => {
  it("inspects without writing and requires offline acknowledgement", async () => {
    const source = directory();
    const target = join(directory(), "new");
    traces(source);
    const before = hashFile(join(source, "telemetry.db"));
    const dryRun = await migrate(source, target, ["--dry-run"]);
    expect(dryRun.status, dryRun.output).toBe(0);
    expect(dryRun.output).toContain("no destination files created");
    expect(existsSync(target)).toBe(false);
    const refused = await migrate(source, target);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain("pass --offline");
    expect(hashFile(join(source, "telemetry.db"))).toBe(before);
  });

  it("preserves blobs, source rowids, keys, timestamp semantics and project-scoped search", async () => {
    const source = directory();
    const target = directory();
    const timestamp = Date.parse("2026-10-06T00:00:00.123Z");
    sqlite(
      join(source, "langfuse.db"),
      `db.exec(\`CREATE TABLE organizations(id TEXT PRIMARY KEY,name TEXT,created_at DATETIME,updated_at DATETIME);
      INSERT INTO organizations VALUES('org','Org','2026-10-06 00:00:00.123',${timestamp});
      CREATE TABLE projects(id TEXT PRIMARY KEY,org_id TEXT,name TEXT,created_at DATETIME,updated_at DATETIME);
      INSERT INTO projects VALUES('project-a','org','Project','2026-10-06 00:00:00.123',${timestamp});
      CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email_verified DATETIME,v4_beta_enabled BOOLEAN,created_at DATETIME,updated_at DATETIME);
      INSERT INTO users VALUES('user','User','2026-10-06 00:00:00.123',1,${timestamp},${timestamp});
      CREATE TABLE Session(id TEXT PRIMARY KEY,session_token TEXT,user_id TEXT,expires DATETIME);
      INSERT INTO Session VALUES('session','session-token','user','2026-10-07T00:00:00.123Z');
      CREATE TABLE api_keys(id TEXT PRIMARY KEY,created_at DATETIME,public_key TEXT,hashed_secret_key TEXT,fast_hashed_secret_key TEXT,display_secret_key TEXT,project_id TEXT,organization_id TEXT,scope TEXT);
      INSERT INTO api_keys VALUES('key','2026-10-06 00:00:00.123','public','bcrypt-hash','fast-hash','masked','project-a','org','PROJECT');\`)`,
    );
    traces(source);
    const input = JSON.stringify({
      messages: [{ role: "user", content: "compressed migration needle".repeat(500) }],
    });
    const bytes = deflateSync(Buffer.from(input));
    sqlite(
      join(source, "telemetry.db"),
      `db.prepare('UPDATE traces SET input=?,input_codec=1,input_raw_size=? WHERE id=?').run(Buffer.from('${bytes.toString("base64")}','base64'),${Buffer.byteLength(input)},'trace-0');db.exec(\`CREATE TABLE search_texts(text_id INTEGER PRIMARY KEY,project_id TEXT,content_hash TEXT,chunk_no INTEGER,display_text TEXT,normalized_text TEXT,project_scope TEXT,index_version INTEGER);
      INSERT INTO search_texts VALUES(19,'project-a','hash',0,'Unicode 🔍 needle','unicode 🔍 needle','scope',1);
      CREATE TABLE search_occurrences(occurrence_id TEXT PRIMARY KEY,project_id TEXT,text_id INTEGER,source_kind TEXT,source_id TEXT,role TEXT,field TEXT,message_order INTEGER,chunk_no INTEGER,source_version INTEGER,event_time TEXT);
      INSERT INTO search_occurrences VALUES('occurrence','project-a',19,'trace','trace-0','user','input',0,0,1,'2026-10-06 00:00:00');
      CREATE TABLE search_source_revisions(project_id TEXT,source_kind TEXT,source_id TEXT,revision INTEGER,PRIMARY KEY(project_id,source_kind,source_id));
      INSERT INTO search_source_revisions VALUES('project-a','trace','trace-0',1);
      CREATE VIRTUAL TABLE search_fts USING fts5(text);
      INSERT INTO search_fts VALUES('obsolete fts cache');\`)`,
    );
    sqlite(
      join(source, "gateway.db"),
      `db.exec(\`CREATE TABLE Provider(id TEXT PRIMARY KEY,projectId TEXT,name TEXT,type TEXT,baseUrl TEXT,apiKeyEncrypted TEXT,createdAt DATETIME,updatedAt DATETIME);
      INSERT INTO Provider VALUES('provider','project-a','Provider','openai','https://example.invalid','encrypted-value',${timestamp},'2026-10-06 00:00:00.123');\`)`,
    );
    writeFileSync(join(source, ".salt"), "salt-value");
    writeFileSync(join(source, ".encryption-key"), "a".repeat(64));
    const before = ["langfuse.db", "telemetry.db", "gateway.db"].map((filename) =>
      hashFile(join(source, filename)),
    );
    const result = await migrate(source, target, ["--offline", "--batch-rows", "2"]);
    expect(result.status, result.output).toBe(0);
    expect(
      ["langfuse.db", "telemetry.db", "gateway.db"].map((filename) =>
        hashFile(join(source, filename)),
      ),
    ).toEqual(before);
    expect(readFileSync(join(target, ".salt"), "utf8")).toBe("salt-value");
    expect(readFileSync(join(target, ".encryption-key"), "utf8")).toBe("a".repeat(64));
    const metadata = await openLocalDatabase(join(target, "langfuse.turso.db"));
    const telemetry = await openLocalDatabase(join(target, "telemetry.turso.db"));
    const gateway = await openLocalDatabase(join(target, "gateway.turso.db"));
    try {
      expect(
        await metadata.get("SELECT email_verified,v4_beta_enabled,created_at FROM users"),
      ).toEqual({ email_verified: timestamp, v4_beta_enabled: 1, created_at: timestamp });
      expect(await metadata.get("SELECT fast_hashed_secret_key FROM api_keys")).toEqual({
        fast_hashed_secret_key: "fast-hash",
      });
      expect(await metadata.get("SELECT expires FROM Session")).toEqual({
        expires: timestamp + 86400000,
      });
      expect(
        await gateway.get("SELECT projectId,apiKeyEncrypted,createdAt,updatedAt FROM provider"),
      ).toEqual({
        projectId: "project-a",
        apiKeyEncrypted: "encrypted-value",
        createdAt: "2026-10-06T00:00:00.123Z",
        updatedAt: "2026-10-06T00:00:00.123Z",
      });
      expect(await telemetry.all("SELECT rowid,id FROM traces ORDER BY rowid")).toEqual([
        { rowid: 1, id: "trace-0" },
        { rowid: 4, id: "trace-1" },
        { rowid: 7, id: "trace-2" },
      ]);
      expect(
        decodeIoRow(
          await telemetry.get(
            "SELECT input,input_codec,input_raw_size FROM traces WHERE id='trace-0'",
          ),
        ).input,
      ).toBe(input);
      expect(await telemetry.get("SELECT text_id FROM search_texts")).toEqual({ text_id: 19 });
      expect(
        await telemetry.get(
          "SELECT text_id FROM search_trigrams WHERE project_id=? AND gram=?",
          "project-a",
          " 🔍 ",
        ),
      ).toEqual({ text_id: 19 });
      expect(
        await telemetry.get(
          "SELECT text_id FROM search_trigrams WHERE project_id=? AND gram=?",
          "project-b",
          " 🔍 ",
        ),
      ).toBeUndefined();
      expect(
        await telemetry.get("SELECT 1 FROM sqlite_master WHERE name='search_fts'"),
      ).toBeUndefined();
      const report = JSON.parse(
        readFileSync(join(target, "telemetry.turso.db.migration.json"), "utf8"),
      );
      expect(report.tables.every((table: { verified: boolean }) => table.verified)).toBe(true);
      expect(report.trigrams.done).toBe(true);
      expect(report.integrity).toEqual({ foreignKeys: "ok", sqliteQuickCheck: "ok" });
    } finally {
      await metadata.close();
      await telemetry.close();
      await gateway.close();
    }
  });

  it("resumes after a committed batch without duplicates or premature publication", async () => {
    const source = directory();
    const target = directory();
    traces(source, 1000);
    const first = await migrate(source, target, ["--offline", "--batch-rows", "1"], true);
    expect(first.status, first.output).toBe(130);
    expect(existsSync(join(target, "telemetry.turso.db"))).toBe(false);
    expect(existsSync(join(target, ".telemetry.turso.db.migrating"))).toBe(true);
    const retry = await migrate(source, target, ["--offline", "--resume"]);
    expect(retry.status, retry.output).toBe(0);
    const db = await openLocalDatabase(join(target, "telemetry.turso.db"));
    try {
      expect(await db.get("SELECT count(*) AS count FROM traces")).toEqual({ count: 1000 });
      expect(await db.get("SELECT max(rowid) AS last FROM traces")).toEqual({ last: 2998 });
    } finally {
      await db.close();
    }
    const again = await migrate(source, target, ["--offline", "--resume"]);
    expect(again.status, again.output).toBe(0);
    expect(again.output).toContain("already published");
  });

  it("refuses changed source snapshots and never overwrites existing target databases", async () => {
    const source = directory();
    const target = directory();
    traces(source, 500);
    const interrupted = await migrate(source, target, ["--offline", "--batch-rows", "1"], true);
    expect(interrupted.status, interrupted.output).toBe(130);
    sqlite(
      join(source, "telemetry.db"),
      "db.exec(\"UPDATE traces SET input='changed' WHERE id='trace-0'\")",
    );
    const retry = await migrate(source, target, ["--offline", "--resume"]);
    expect(retry.status).toBe(1);
    expect(retry.output).toContain("source changed");
    const bytes = Buffer.from("existing-database-never-overwrite");
    writeFileSync(join(target, "telemetry.turso.db"), bytes);
    const existing = await migrate(source, target, ["--offline"]);
    expect(existing.status).toBe(1);
    expect(readFileSync(join(target, "telemetry.turso.db"))).toEqual(bytes);
  });

  it("recovers committed Turso WAL batches and stale ownership locks after SIGKILL", async () => {
    const source = directory();
    const target = directory();
    traces(source, 500);
    const first = await migrate(source, target, ["--offline", "--batch-rows", "1"], "SIGKILL");
    expect(first.status).toBeNull();
    expect(existsSync(join(target, ".legacy-turso-migration.lock"))).toBe(true);
    const resumed = await migrate(source, target, ["--offline", "--resume"]);
    expect(resumed.status, resumed.output).toBe(0);
    const db = await openLocalDatabase(join(target, "telemetry.turso.db"));
    try {
      expect(await db.get("SELECT count(*) AS count FROM traces")).toEqual({ count: 500 });
    } finally {
      await db.close();
    }
  });

  it("fails closed on unmapped business data or conflicting key files", async () => {
    const source = directory();
    const target = directory();
    traces(source);
    sqlite(
      join(source, "telemetry.db"),
      "db.exec('CREATE TABLE sqliteBusiness(id TEXT); INSERT INTO sqliteBusiness VALUES(1)')",
    );
    const unknown = await migrate(source, target, ["--offline"]);
    expect(unknown.status).toBe(1);
    expect(unknown.output).toContain("refuses to discard business data");
    expect(readdirSync(target)).toEqual([]);
    writeFileSync(join(source, ".salt"), "source-salt");
    writeFileSync(join(target, ".salt"), "different-salt");
    const keys = await migrate(source, target, ["--offline"]);
    expect(keys.status).toBe(1);
    expect(keys.output).toContain("differs from the source");
  });

  it("checks migration ownership read-only before opening an existing destination for writes", async () => {
    const source = directory();
    const target = directory();
    traces(source);
    const filename = join(target, "telemetry.turso.db");
    sqlite(
      filename,
      "db.exec(\"CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('keep-original')\")",
    );
    chmodSync(filename, 0o640);
    const before = hashFile(filename);
    const result = await migrate(source, target, ["--offline", "--resume"]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("different migration");
    expect(hashFile(filename)).toBe(before);
    expect(statSync(filename).mode & 0o777).toBe(0o640);
  });

  it("does not publish imported databases with broken foreign keys", async () => {
    const source = directory();
    const target = directory();
    sqlite(
      join(source, "langfuse.db"),
      "db.exec(\"CREATE TABLE projects(id TEXT,org_id TEXT,name TEXT,created_at DATETIME,updated_at DATETIME); INSERT INTO projects VALUES('orphan','missing-org','Orphan','2026-10-06 00:00:00','2026-10-06 00:00:00')\")",
    );
    const result = await migrate(source, target, ["--offline"]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("foreign-key validation failed");
    expect(existsSync(join(target, "langfuse.turso.db"))).toBe(false);
  });

  it("preserves integers and rowids beyond JavaScript's safe integer range", async () => {
    const source = directory();
    const target = directory();
    traces(source, 1);
    sqlite(
      join(source, "telemetry.db"),
      "db.exec(\"UPDATE traces SET rowid=9007199254740993;CREATE TABLE trace_metrics(project_id TEXT,trace_id TEXT,obs_count INTEGER,PRIMARY KEY(project_id,trace_id));INSERT INTO trace_metrics VALUES('project-a','trace-0',9007199254740993)\")",
    );
    const result = await migrate(source, target, ["--offline"]);
    expect(result.status, result.output).toBe(0);
    const db = await openLocalDatabase(join(target, "telemetry.turso.db"));
    try {
      const statement = await db.prepare("SELECT rowid FROM traces");
      expect(await statement.safeIntegers(true).get()).toEqual({ rowid: 9007199254740993n });
      statement.close();
      const metrics = await db.prepare("SELECT obs_count FROM trace_metrics");
      expect(await metrics.safeIntegers(true).get()).toEqual({ obs_count: 9007199254740993n });
      metrics.close();
    } finally {
      await db.close();
    }
  });

  it("reads committed WAL data without modifying the legacy database", async () => {
    const source = directory();
    const target = directory();
    const filename = join(source, "telemetry.db");
    const writer = spawn(process.execPath, [
      "--experimental-sqlite",
      "-e",
      `const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec("PRAGMA journal_mode=WAL; CREATE TABLE traces(id TEXT,project_id TEXT,timestamp TEXT,PRIMARY KEY(project_id,id));INSERT INTO traces VALUES('wal-trace','project-a','2026-10-06 00:00:00')");console.log('ready');setInterval(()=>{},1000);`,
      filename,
    ]);
    children.push(writer);
    await new Promise<void>((resolveReady, reject) => {
      writer.stdout.once("data", () => resolveReady());
      writer.once("error", reject);
    });
    const main = hashFile(filename);
    const wal = hashFile(`${filename}-wal`);
    const result = await migrate(source, target, ["--offline"]);
    expect(result.status, result.output).toBe(0);
    expect(hashFile(filename)).toBe(main);
    expect(hashFile(`${filename}-wal`)).toBe(wal);
    const db = await openLocalDatabase(join(target, "telemetry.turso.db"));
    try {
      expect(await db.get("SELECT id FROM traces")).toEqual({ id: "wal-trace" });
    } finally {
      await db.close();
    }
  });
});
