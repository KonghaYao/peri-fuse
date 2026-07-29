/** Stub: Evals types not available in lite mode. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";
export const EvalTargetObjectSchema = z.enum(["trace", "observation", "dataset_run_item"]);
export type EvalTargetObject = z.infer<typeof EvalTargetObjectSchema>;
