import { and, desc, eq, gt, inArray, type SQL } from "drizzle-orm";
import {
  type Action,
  ActionExecutionStatus,
  type JobConfigState,
  prisma,
  type Trigger,
} from "../../db";
import {
  actions as actionsTable,
  automationExecutions as automationExecutionsTable,
  automations as automationsTable,
  triggers as triggersTable,
} from "../../db/schema/index.js";
import {
  type ActionDomain,
  type ActionDomainWithSecrets,
  type AutomationDomain,
  convertToSafeWebhookConfig,
  isSafeWebhookActionConfig,
  isWebhookActionConfig,
  type SafeActionConfig,
  type TriggerDomain,
  type TriggerEventAction,
  type TriggerEventSource,
  type WebhookActionConfigWithSecrets,
} from "../../domain/automations";
import type { FilterState } from "../../types";
import { decryptSecretHeaders, mergeHeaders } from "../utils/headerUtils";

export const getActionByIdWithSecrets = async ({
  projectId,
  actionId,
}: {
  projectId: string;
  actionId: string;
}): Promise<ActionDomainWithSecrets | null> => {
  const actionConfig = await prisma
    .select()
    .from(actionsTable)
    .where(and(eq(actionsTable.id, actionId), eq(actionsTable.projectId, projectId)))
    .limit(1)
    .then((rows) => rows[0]);

  if (!actionConfig) {
    return null;
  }

  if (isWebhookActionConfig(actionConfig.config)) {
    const config = actionConfig.config; // Type guard ensures this is WebhookActionConfigWithSecrets

    // Decrypt secret headers for webhook execution using new structure
    const decryptedHeaders = config.requestHeaders
      ? decryptSecretHeaders(mergeHeaders(config.headers, config.requestHeaders))
      : config.headers
        ? Object.entries(config.headers).reduce(
            (acc, [key, value]) => {
              acc[key] = { secret: false, value };
              return acc;
            },
            {} as Record<string, { secret: boolean; value: string }>,
          )
        : {};

    return {
      ...actionConfig,
      config: {
        type: config.type,
        url: config.url,
        requestHeaders: decryptedHeaders,
        displayHeaders: getDisplayHeaders(config),
        apiVersion: config.apiVersion,
        displaySecretKey: config.displaySecretKey,
        secretKey: config.secretKey,
        lastFailingExecutionId: config.lastFailingExecutionId,
      },
    };
  }

  // For SLACK and others, return as stored (already safe)
  return actionConfig as unknown as ActionDomainWithSecrets;
};

export const getActionById = async ({
  projectId,
  actionId,
}: {
  projectId: string;
  actionId: string;
}): Promise<ActionDomain | null> => {
  const actionConfig = await prisma
    .select()
    .from(actionsTable)
    .where(and(eq(actionsTable.id, actionId), eq(actionsTable.projectId, projectId)))
    .limit(1)
    .then((rows) => rows[0]);

  if (!actionConfig) {
    return null;
  }

  const actionDomain = convertActionToDomain(actionConfig);

  return actionDomain;
};

export type TriggerDomainWithActions = TriggerDomain & {
  actionIds: string[];
  automations: { id: string; actionId: string }[];
};

export const getTriggerConfigurations = async ({
  projectId,
  eventSource,
  status,
}: {
  projectId: string;
  eventSource: TriggerEventSource;
  status: JobConfigState;
}): Promise<TriggerDomainWithActions[]> => {
  const foundTriggers = await prisma.query.triggers.findMany({
    where: and(
      eq(triggersTable.projectId, projectId),
      eq(triggersTable.eventSource, eventSource),
      eq(triggersTable.status, status),
    ),
    with: {
      automations: {
        with: { action: true },
      },
    },
  });

  const triggerConfigurations = foundTriggers.map((trigger) => ({
    ...convertTriggerToDomain(trigger),
    actionIds: trigger.automations.map((automation) => automation.action.id),
    automations: trigger.automations.map((automation) => ({
      id: automation.id,
      actionId: automation.action.id,
    })),
  }));

  return triggerConfigurations;
};

const convertTriggerToDomain = (trigger: Trigger): TriggerDomain => {
  return {
    ...trigger,
    eventActions: (trigger.eventActions || []) as TriggerEventAction[],
    filter: (trigger.filter || []) as FilterState,
    eventSource: trigger.eventSource as TriggerEventSource,
  };
};

const getDisplayHeaders = (config: WebhookActionConfigWithSecrets) => {
  let displayHeaders = config.displayHeaders;
  if (!displayHeaders && config.headers) {
    // Convert legacy headers to displayHeaders format
    displayHeaders = Object.entries(config.headers).reduce(
      (acc, [key, value]) => {
        acc[key] = { secret: false, value };
        return acc;
      },
      {} as Record<string, { secret: boolean; value: string }>,
    );
  }
  return displayHeaders;
};

const convertActionToDomain = (action: Action): ActionDomain => {
  if (isWebhookActionConfig(action.config)) {
    const config = action.config;
    config.displayHeaders = getDisplayHeaders(config);

    return {
      ...action,
      config: convertToSafeWebhookConfig(config),
    };
  }

  // For SLACK (or future types) return config as-is
  return {
    ...action,
    config: action.config as unknown as SafeActionConfig,
  } as ActionDomain;
};

export const getAutomationById = async ({
  projectId,
  automationId,
}: {
  projectId: string;
  automationId: string;
}): Promise<AutomationDomain | null> => {
  const automation = await prisma.query.automations.findFirst({
    where: and(eq(automationsTable.id, automationId), eq(automationsTable.projectId, projectId)),
    with: {
      action: true,
      trigger: true,
    },
  });

  if (!automation) {
    return null;
  }

  return {
    id: automation.id,
    name: automation.name,
    trigger: convertTriggerToDomain(automation.trigger),
    action: convertActionToDomain(automation.action),
  };
};

export const getAutomations = async ({
  projectId,
  triggerId,
  actionId,
  eventSource,
}: {
  projectId: string;
  triggerId?: string;
  actionId?: string;
  eventSource?: TriggerEventSource;
}): Promise<AutomationDomain[]> => {
  const conditions: SQL[] = [eq(automationsTable.projectId, projectId)];
  if (triggerId) conditions.push(eq(automationsTable.triggerId, triggerId));
  if (actionId) conditions.push(eq(automationsTable.actionId, actionId));

  const foundAutomations = await prisma.query.automations.findMany({
    where: and(...conditions),
    with: {
      action: true,
      trigger: true,
    },
    orderBy: desc(automationsTable.createdAt),
  });

  const domains = foundAutomations
    .filter((automation) => !eventSource || automation.trigger.eventSource === eventSource)
    .map((automation) => ({
      id: automation.id,
      name: automation.name,
      trigger: convertTriggerToDomain(automation.trigger),
      action: convertActionToDomain(automation.action),
    }));

  return domains;
};

export const getConsecutiveAutomationFailures = async ({
  automationId,
  projectId,
}: {
  automationId: string;
  projectId: string;
}): Promise<number> => {
  const automation = await getAutomationById({
    automationId,
    projectId,
  });

  if (!automation) {
    return 0;
  }

  // Build where clause - if lastFailingExecutionId is set, only consider executions newer than it
  const whereConditions: SQL[] = [
    eq(automationExecutionsTable.triggerId, automation.trigger.id),
    eq(automationExecutionsTable.actionId, automation.action.id),
    eq(automationExecutionsTable.projectId, projectId),
    inArray(automationExecutionsTable.status, [
      ActionExecutionStatus.ERROR,
      ActionExecutionStatus.COMPLETED,
    ]),
  ];

  // If there's a lastFailingExecutionId, we need to get executions that are newer than that execution
  if (
    isSafeWebhookActionConfig(automation.action.config) &&
    automation.action.config.lastFailingExecutionId
  ) {
    // First get the timestamp of the last failing execution
    const lastFailingExecution = await prisma
      .select({ createdAt: automationExecutionsTable.createdAt })
      .from(automationExecutionsTable)
      .where(eq(automationExecutionsTable.id, automation.action.config.lastFailingExecutionId))
      .limit(1)
      .then((rows) => rows[0]);

    if (lastFailingExecution) {
      whereConditions.push(gt(automationExecutionsTable.createdAt, lastFailingExecution.createdAt));
    }
  }

  const executions = await prisma
    .select({ status: automationExecutionsTable.status })
    .from(automationExecutionsTable)
    .where(and(...whereConditions))
    .orderBy(desc(automationExecutionsTable.createdAt))
    .limit(20);

  let consecutiveFailures = 0;
  for (const execution of executions) {
    if (execution.status === ActionExecutionStatus.ERROR) {
      consecutiveFailures++;
    } else if (execution.status === ActionExecutionStatus.COMPLETED) {
      break; // Stop counting when we hit a successful execution
    }
    // Skip PENDING/CANCELLED executions in the count
  }

  return consecutiveFailures;
};
