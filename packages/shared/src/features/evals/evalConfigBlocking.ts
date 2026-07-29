/** Stub: Eval config blocking not available in lite mode. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";
export const JobConfigExecutionMode = z.enum(["sync", "async"]);
export type JobConfigExecutionModeType = z.infer<typeof JobConfigExecutionMode>;
