/**
 * Environment configuration for PeriGateway.
 * Resolves DB path and provides typed env access.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Global data directory shared with the server (SQLite databases, keys).
 * Override with PERIFUSE_HOME. Defaults to ~/.peri-fuse.
 */
const dataDir = process.env.PERIFUSE_HOME || path.join(os.homedir(), ".peri-fuse");

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Resolve SQLite database URL
if (!process.env.GATEWAY_DB_URL) {
  process.env.GATEWAY_DB_URL = `file:${path.join(dataDir, "gateway.db")}`;
} else if (process.env.GATEWAY_DB_URL.startsWith("file:")) {
  const rawPath = process.env.GATEWAY_DB_URL.slice("file:".length);
  if (!path.isAbsolute(rawPath)) {
    process.env.GATEWAY_DB_URL = `file:${path.resolve(process.cwd(), rawPath)}`;
  }
}

// Auto-generate encryption key if not provided (for dev convenience)
if (!process.env.GATEWAY_ENCRYPTION_KEY) {
  const keyFile = path.join(dataDir, ".encryption-key");
  if (fs.existsSync(keyFile)) {
    process.env.GATEWAY_ENCRYPTION_KEY = fs.readFileSync(keyFile, "utf8").trim();
  } else {
    const { randomBytes } = require("node:crypto");
    const key = randomBytes(32).toString("hex");
    fs.writeFileSync(keyFile, key, "utf8");
    process.env.GATEWAY_ENCRYPTION_KEY = key;
  }
}

export const gatewayEnv = {
  port: process.env.GATEWAY_PORT ? parseInt(process.env.GATEWAY_PORT, 10) : 4100,
  dbUrl: process.env.GATEWAY_DB_URL!,
  encryptionKey: process.env.GATEWAY_ENCRYPTION_KEY!,
  logRequests: process.env.GATEWAY_LOG_REQUESTS !== "false",
  logMaxBodySize: process.env.GATEWAY_LOG_MAX_BODY_SIZE
    ? parseInt(process.env.GATEWAY_LOG_MAX_BODY_SIZE, 10)
    : 10240,
  flushIntervalMs: process.env.GATEWAY_FLUSH_INTERVAL_MS
    ? parseInt(process.env.GATEWAY_FLUSH_INTERVAL_MS, 10)
    : 30_000,
  dailyFlushIntervalMs: process.env.GATEWAY_DAILY_FLUSH_INTERVAL_MS
    ? parseInt(process.env.GATEWAY_DAILY_FLUSH_INTERVAL_MS, 10)
    : 60_000,
  // PeriFuse integration
  perifuseEndpoint: process.env.PERIFUSE_ENDPOINT ?? null,
  perifusePublicKey: process.env.PERIFUSE_PUBLIC_KEY ?? null,
  perifuseSecretKey: process.env.PERIFUSE_SECRET_KEY ?? null,
  // Slow request log
  slowLogEnabled: process.env.GATEWAY_SLOW_LOG_ENABLED === "true",
  slowLogThresholdMs: process.env.GATEWAY_SLOW_LOG_THRESHOLD_MS
    ? parseInt(process.env.GATEWAY_SLOW_LOG_THRESHOLD_MS, 10)
    : 100,
  slowLogRetentionDays: process.env.GATEWAY_SLOW_LOG_RETENTION_DAYS
    ? parseInt(process.env.GATEWAY_SLOW_LOG_RETENTION_DAYS, 10)
    : 7,
  slowLogDir: process.env.GATEWAY_SLOW_LOG_DIR ?? path.join(dataDir, "slow-logs"),
} as const;
