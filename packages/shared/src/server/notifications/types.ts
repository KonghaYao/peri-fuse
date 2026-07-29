/** Stub: Notification types not available in lite mode. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";

export const ProjectNotificationWebhookQueueEventSchema = z.object({
  type: z.literal("system-notification"),
  projectId: z.string(),
  notificationId: z.string().optional(),
  timestamp: z.date().optional(),
});

export type ProjectNotificationWebhookQueueEvent = z.infer<
  typeof ProjectNotificationWebhookQueueEventSchema
>;
