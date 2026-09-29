/** Known observation types accepted by the public API; keep filters and types in sync. */
export const OBSERVATION_TYPES = [
  "SPAN",
  "GENERATION",
  "EVENT",
  "AGENT",
  "TOOL",
  "CHAIN",
  "RETRIEVER",
  "EVALUATOR",
  "EMBEDDING",
  "GUARDRAIL",
] as const;

export type ObservationType = (typeof OBSERVATION_TYPES)[number];

export type Observation = {
  id: string;
  traceId: string | null;
  parentObservationId: string | null;
  type: ObservationType | string;
  name: string | null;
  startTime: string;
  endTime: string | null;
  level: string | null;
  statusMessage: string | null;
  version: string | null;
  environment?: string | null;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
  model: string | null;
  modelId?: string | null;
  modelParameters?: unknown;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usage?: { input: number; output: number; total: number; unit: string };
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
  calculatedInputCost?: number | null;
  calculatedOutputCost?: number | null;
  calculatedTotalCost?: number | null;
  completionStartTime?: string | null;
  promptId?: string | null;
  promptName?: string | null;
  promptVersion?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

export type ObservationListParams = {
  page?: number;
  limit?: number;
  traceId?: string;
  userId?: string;
  name?: string;
  type?: string;
  level?: string;
  environment?: string;
  parentObservationId?: string;
  fromStartTime?: string;
  toStartTime?: string;
  version?: string;
};
