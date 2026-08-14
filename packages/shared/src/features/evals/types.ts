/**
 * Eval domain types + public API schemas (lite mode).
 *
 * Replaces the previous "Stub: Evals types not available in lite mode" file.
 * Eval configs map 1:1 onto `job_configurations` (jobType=EVAL) — no
 * `eval_configs` table exists (docs/evals/phase-1-api-compat.md §7 D1-B).
 *
 * NOTE: contract pending upstream alignment — there is no stable upstream
 * `/api/public/evals*` contract (docs/evals/phase-1-api-compat.md §4.3/§4.4,
 * R6). `EvalConfig.name`/`version` are derived at the server shaping layer:
 * the `job_configurations` table has no name/version columns, so `name`
 * follows the referenced eval template (falling back to scoreName) and
 * `version` is the ordinal of the config among same-scoreName configs of the
 * project. TODO: align once an upstream contract lands.
 */
import { z } from "zod";
import {
  EvalTemplateSourceCodeLanguage,
  EvalTemplateType,
  JobConfigState,
} from "../../prisma-enums";

// Target object enum — kept from the previous stub (consumed by
// packages/shared/src/server/queues.ts).
export const EvalTargetObjectSchema = z.enum(["trace", "observation", "dataset_run_item"]);
export type EvalTargetObject = z.infer<typeof EvalTargetObjectSchema>;

// ── Eval configs (job_configurations, jobType=EVAL) ──────────────────────────

export const EvalConfigStatusSchema = z.enum(JobConfigState);
export type EvalConfigStatus = z.infer<typeof EvalConfigStatusSchema>;

export const EvalConfigTimeScopeSchema = z.array(z.string()).default(["NEW"]);

export const CreateEvalConfigSchema = z.object({
  // Required by the planned contract, but NOT persisted: job_configurations
  // has no name column. The API response derives `name` from the referenced
  // eval template (or scoreName).
  name: z.string().min(1),
  scoreName: z.string().min(1),
  targetObject: EvalTargetObjectSchema,
  filter: z.array(z.unknown()).default([]),
  variableMapping: z.record(z.string(), z.unknown()).default({}),
  sampling: z.number().min(0).max(1).default(1),
  delay: z.number().int().min(0).default(0),
  timeScope: EvalConfigTimeScopeSchema,
  evalTemplateId: z.string().nullish(),
  status: EvalConfigStatusSchema.default("ACTIVE"),
});
export type CreateEvalConfigRequest = z.infer<typeof CreateEvalConfigSchema>;

export const UpdateEvalConfigSchema = z.object({
  name: z.string().min(1).optional(),
  scoreName: z.string().min(1).optional(),
  targetObject: EvalTargetObjectSchema.optional(),
  filter: z.array(z.unknown()).optional(),
  variableMapping: z.record(z.string(), z.unknown()).optional(),
  sampling: z.number().min(0).max(1).optional(),
  delay: z.number().int().min(0).optional(),
  timeScope: z.array(z.string()).optional(),
  evalTemplateId: z.string().nullish(),
  status: EvalConfigStatusSchema.optional(),
});
export type UpdateEvalConfigRequest = z.infer<typeof UpdateEvalConfigSchema>;

export const EvalConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int().min(1),
  scoreName: z.string(),
  targetObject: EvalTargetObjectSchema,
  filter: z.array(z.unknown()),
  variableMapping: z.record(z.string(), z.unknown()),
  sampling: z.number().min(0).max(1),
  delay: z.number().int().min(0),
  timeScope: z.array(z.string()),
  status: EvalConfigStatusSchema,
  evalTemplateId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  projectId: z.string(),
});
export type EvalConfig = z.infer<typeof EvalConfigSchema>;

// ── Eval templates (eval_templates) ──────────────────────────────────────────

const evalTemplateTypeCodeRequiresSourceCode = (
  data: { type?: string; sourceCode?: string | null },
  ctx: z.RefinementCtx,
): void => {
  if (data.type === "CODE" && !data.sourceCode) {
    ctx.addIssue({
      code: "custom",
      path: ["sourceCode"],
      message: "sourceCode is required for CODE eval templates",
    });
  }
};

export const CreateEvalTemplateSchema = z
  .object({
    name: z.string().min(1),
    // `version` is intentionally absent: the server assigns it per
    // (projectId, name) — new names start at 1, re-creations increment
    // (docs/evals/phase-1-api-compat.md §7 D3).
    prompt: z.string().optional(),
    type: z.enum(EvalTemplateType).default("LLM_AS_JUDGE"),
    partner: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    modelParams: z.record(z.string(), z.unknown()).optional(),
    vars: z.array(z.string()).default([]),
    outputSchema: z.unknown().optional(),
    sourceCode: z.string().optional(),
    sourceCodeLanguage: z.enum(EvalTemplateSourceCodeLanguage).optional(),
  })
  .superRefine(evalTemplateTypeCodeRequiresSourceCode);
export type CreateEvalTemplateRequest = z.infer<typeof CreateEvalTemplateSchema>;

export const UpdateEvalTemplateSchema = z
  .object({
    name: z.string().min(1).optional(),
    prompt: z.string().nullish(),
    type: z.enum(EvalTemplateType).optional(),
    partner: z.string().nullish(),
    model: z.string().nullish(),
    provider: z.string().nullish(),
    modelParams: z.record(z.string(), z.unknown()).nullish(),
    vars: z.array(z.string()).optional(),
    outputSchema: z.unknown().nullish(),
    sourceCode: z.string().nullish(),
    sourceCodeLanguage: z.enum(EvalTemplateSourceCodeLanguage).nullish(),
  })
  .superRefine(evalTemplateTypeCodeRequiresSourceCode);
export type UpdateEvalTemplateRequest = z.infer<typeof UpdateEvalTemplateSchema>;

export const EvalTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int().min(1),
  prompt: z.string().optional(),
  type: z.enum(EvalTemplateType),
  partner: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  modelParams: z.record(z.string(), z.unknown()).optional(),
  vars: z.array(z.string()),
  outputSchema: z.unknown().optional(),
  sourceCode: z.string().optional(),
  sourceCodeLanguage: z.enum(EvalTemplateSourceCodeLanguage).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  projectId: z.string().optional(),
});
export type EvalTemplate = z.infer<typeof EvalTemplateSchema>;
