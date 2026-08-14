/**
 * Eval config blocking / validation helpers (lite mode).
 *
 * Replaces the previous "Stub: Eval config blocking not available in lite
 * mode" file. Upstream evaluates blocking state via Redis/ClickHouse; lite
 * mode has neither, so this module only provides lightweight structural
 * validation of eval config fields. `JobConfigExecutionMode` is kept for
 * backward compatibility (consumed by packages/shared/src/server/queues.ts).
 */
import { z } from "zod";
import { EvalTargetObjectSchema } from "./types";

/** Execution mode for observation eval jobs (sync = inline, async = queued). */
export const JobConfigExecutionMode = z.enum(["sync", "async"]);
export type JobConfigExecutionModeType = z.infer<typeof JobConfigExecutionMode>;

export type EvalConfigFields = {
  targetObject?: unknown;
  filter?: unknown;
  variableMapping?: unknown;
  sampling?: unknown;
};

/**
 * Lightweight structural validation for eval config fields. Returns a list of
 * human-readable error messages (empty array = valid). Mirrors the DB column
 * contracts of `job_configurations` (packages/shared/src/db/schema/schema.ts:664)
 * without the upstream Redis/ClickHouse blocking machinery.
 */
export function validateEvalConfigFields(fields: EvalConfigFields): string[] {
  const errors: string[] = [];

  if (
    fields.targetObject !== undefined &&
    !EvalTargetObjectSchema.safeParse(fields.targetObject).success
  ) {
    errors.push("targetObject must be one of: trace, observation, dataset_run_item");
  }

  if (fields.filter !== undefined && !Array.isArray(fields.filter)) {
    errors.push("filter must be an array");
  }

  if (
    fields.variableMapping !== undefined &&
    (typeof fields.variableMapping !== "object" ||
      fields.variableMapping === null ||
      Array.isArray(fields.variableMapping))
  ) {
    errors.push("variableMapping must be an object");
  }

  if (
    fields.sampling !== undefined &&
    (typeof fields.sampling !== "number" ||
      Number.isNaN(fields.sampling) ||
      fields.sampling < 0 ||
      fields.sampling > 1)
  ) {
    errors.push("sampling must be a number between 0 and 1");
  }

  return errors;
}
