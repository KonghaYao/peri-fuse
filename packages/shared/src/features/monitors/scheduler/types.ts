/** Stub: Monitor scheduler types not available in lite mode. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";

export const MonitorWebhookQueueEventSchema = z.object({
  type: z.literal("monitor-alert"),
  monitorId: z.string(),
  projectId: z.string(),
  timestamp: z.date().optional(),
});

export type MonitorQueueEvent = z.infer<typeof MonitorWebhookQueueEventSchema>;
export type MonitorQueueEventInput = {
  monitorId: string;
  projectId: string;
  timestamp?: Date;
};
