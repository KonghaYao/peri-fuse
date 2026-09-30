import { z } from "zod";
import { singleFilter } from "../../../interfaces/filters";
import { MonitorSeverity } from "../../../prisma-enums";
import { views } from "../../query/types";

/** Preserve the outbound webhook contract even though Lite has no monitor scheduler. */
export const MonitorWebhookQueueEventSchema = z.object({
  id: z.string(),
  timestamp: z.date(),
  type: z.literal("monitor-alert"),
  apiVersion: z.literal("v1"),
  payload: z.object({
    monitorId: z.string(),
    projectId: z.string(),
    permalink: z.url(),
    message: z.object({ title: z.string(), body: z.string() }),
    severity: z.enum(MonitorSeverity),
    timestamp: z.date(),
    fromTimestamp: z.date(),
    toTimestamp: z.date(),
    view: views,
    filters: z.array(singleFilter),
    window: z.string().min(1),
  }),
});

/** Scheduler jobs carry identifiers; they are distinct from outbound webhook envelopes. */
export type MonitorQueueEvent = MonitorQueueEventInput & { type: "monitor-alert" };
export type MonitorQueueEventInput = {
  monitorId: string;
  projectId: string;
  timestamp?: Date;
};
