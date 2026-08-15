/**
 * Zod schemas for the v2 prompts public API (spec v4.10.0).
 *
 * Contract highlights (official semantics, review-verified):
 *  - POST body is a oneOf: chat (prompt is an array of messages, `type`
 *    required) / text (prompt is a string, `type` defaults to "text").
 *  - GET {promptName} selection: `version` XOR `label` (default "production").
 *    `isActive` never participates in selection — it is derived in shaping
 *    (labels contain "production").
 *  - `resolve` is the dependency-resolution switch (default true), NOT a
 *    version-selection parameter.
 */

import { publicApiPaginationZod } from "@peri-fuse/shared";
import { stringDateTime } from "@peri-fuse/shared/src/server";
import { z } from "zod";

/** Chat message (spec ChatMessage). */
const ChatMessage = z.object({
  role: z.string().min(1),
  content: z.string(),
  type: z.literal("chatmessage").optional(),
});

/** Dependency placeholder message (spec PlaceholderMessage). */
const PlaceholderMessage = z.object({
  name: z.string().min(1),
  type: z.literal("placeholder").optional(),
});

/** spec ChatMessageWithPlaceholders. */
export const ChatMessageWithPlaceholders = z.union([ChatMessage, PlaceholderMessage]);

/** spec CreateChatPromptRequest. */
export const CreateChatPromptSchema = z.object({
  name: z.string().min(1),
  prompt: z.array(ChatMessageWithPlaceholders),
  config: z.unknown().nullish(),
  type: z.literal("chat"),
  labels: z.array(z.string().min(1)).nullish(),
  tags: z.array(z.string().min(1)).nullish(),
  commitMessage: z.string().nullish(),
});

/** spec CreateTextPromptRequest (`type` is nullable, defaults to "text"). */
export const CreateTextPromptSchema = z.object({
  name: z.string().min(1),
  prompt: z.string(),
  config: z.unknown().nullish(),
  type: z.literal("text").nullish().default("text"),
  labels: z.array(z.string().min(1)).nullish(),
  tags: z.array(z.string().min(1)).nullish(),
  commitMessage: z.string().nullish(),
});

/** spec CreatePromptRequest — oneOf chat/text, discriminated by the prompt shape. */
export const CreatePromptSchema = z.union([CreateChatPromptSchema, CreateTextPromptSchema]);

export type CreatePromptBody = {
  name: string;
  prompt: unknown;
  type: "text" | "chat";
  config?: unknown;
  labels?: string[] | null;
  tags?: string[] | null;
  commitMessage?: string | null;
};

const emptyToUndefined = (x: unknown) => (x === "" ? undefined : x);

/**
 * GET /api/public/v2/prompts/{promptName} query.
 * version/label are mutually exclusive (validated in the route, 400);
 * resolve defaults to true.
 */
export const GetPromptV2Query = z.object({
  version: z.preprocess(emptyToUndefined, z.coerce.number().int().nullish()),
  label: z.preprocess(emptyToUndefined, z.string().min(1).nullish()),
  resolve: z
    .preprocess(emptyToUndefined, z.enum(["true", "false"]).nullish())
    .transform((v) => v !== "false"),
});

/**
 * GET /api/public/v2/prompts query.
 * Response is PromptMetaListResponse — name-level aggregation with
 * lastConfig = config of the most recent matching version.
 */
export const ListPromptsV2Query = z.object({
  ...publicApiPaginationZod,
  name: z.preprocess(emptyToUndefined, z.string().min(1).nullish()),
  label: z.preprocess(emptyToUndefined, z.string().min(1).nullish()),
  tag: z.preprocess(emptyToUndefined, z.string().min(1).nullish()),
  fromUpdatedAt: stringDateTime,
  toUpdatedAt: stringDateTime,
});

/** DELETE /api/public/v2/prompts/{promptName} query (label/version filters). */
export const DeletePromptV2Query = z.object({
  label: z.preprocess(emptyToUndefined, z.string().min(1).nullish()),
  version: z.preprocess(emptyToUndefined, z.coerce.number().int().nullish()),
});

/** PATCH /api/public/v2/prompts/{name}/versions/{version} body. */
export const PatchPromptVersionBody = z.object({
  newLabels: z.array(z.string().min(1)),
});
