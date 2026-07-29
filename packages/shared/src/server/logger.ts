import * as fs from "node:fs";
import * as path from "node:path";
import { context, propagation } from "@opentelemetry/api";
import winston from "winston";
import { env } from "../env";
import { getCurrentSpan } from "./instrumentation";

const tracingFormat = () =>
  winston.format((info) => {
    const span = getCurrentSpan();
    if (span) {
      const { spanId, traceId } = span.spanContext();
      const traceIdEnd = traceId.slice(traceId.length / 2);
      info["dd.trace_id"] = BigInt(`0x${traceIdEnd}`).toString();
      info["dd.span_id"] = BigInt(`0x${spanId}`).toString();
      info.trace_id = traceId;
      info.span_id = spanId;
    }
    const baggage = propagation.getBaggage(context.active());
    if (baggage) {
      const headerObj: Record<string, string> = {};
      baggage.getAllEntries().forEach(([k, v]) => (headerObj[k] = v.value));
      if (Object.keys(headerObj).length) info = { ...headerObj, ...info };
    }
    return info;
  })();

const getWinstonLogger = (_nodeEnv: "development" | "production" | "test", minLevel = "info") => {
  const textLoggerFormat = winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.timestamp(),
    winston.format.align(),
    winston.format.printf((info) => {
      const logMessage = `${info.timestamp} ${info.level} ${info.message}`;
      return info.stack ? `${logMessage}\n${info.stack}` : logMessage;
    }),
  );

  const jsonLoggerFormat = winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.timestamp(),
    tracingFormat(),
    winston.format.json(),
  );

  const format = env.LANGFUSE_LOG_FORMAT === "text" ? textLoggerFormat : jsonLoggerFormat;

  const transports: winston.transport[] = [new winston.transports.Console()];

  // In lite mode, persist logs to .langfuse/logs/ for post-mortem debugging.
  if (process.env.LANGFUSE_MODE === "lite") {
    const logDir = path.resolve(findMonorepoRoot(), ".langfuse", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    transports.push(
      new winston.transports.File({
        filename: path.join(logDir, "langfuse.log"),
        maxsize: 10 * 1024 * 1024, // 10 MB
        maxFiles: 5,
        tailable: true,
      }),
      new winston.transports.File({
        filename: path.join(logDir, "error.log"),
        level: "error",
        maxsize: 5 * 1024 * 1024, // 5 MB
        maxFiles: 3,
        tailable: true,
      }),
    );
  }

  return winston.createLogger({
    level: minLevel,
    format: format,
    transports,
  });
};

/** Find monorepo root by traversing up from CWD looking for pnpm-workspace.yaml */
function findMonorepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const logger = getWinstonLogger(env.NODE_ENV, env.LANGFUSE_LOG_LEVEL);
