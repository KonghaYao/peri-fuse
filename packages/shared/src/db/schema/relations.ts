import { relations } from "drizzle-orm/relations";
import {
  account,
  actions,
  annotationQueueAssignments,
  annotationQueueItems,
  annotationQueues,
  apiKeys,
  automationExecutions,
  automations,
  batchActions,
  batchExports,
  blobStorageIntegrations,
  cloudSpendAlerts,
  commentReactions,
  comments,
  dashboards,
  dashboardWidgets,
  datasetItems,
  datasetRuns,
  datasets,
  defaultLlmModels,
  defaultViews,
  evalTemplates,
  inAppAgentConversations,
  inAppAgentEvents,
  inAppAgentPendingToolApprovals,
  inAppAgentRuns,
  jobConfigurations,
  jobExecutions,
  llmApiKeys,
  llmSchemas,
  llmTools,
  media,
  membershipInvitations,
  mixpanelIntegrations,
  models,
  monitors,
  notificationPreferences,
  organizationMemberships,
  organizations,
  pendingDeletions,
  posthogIntegrations,
  prices,
  pricingTiers,
  projectMemberships,
  projects,
  promptDependencies,
  promptProtectedLabels,
  prompts,
  scoreConfigs,
  session,
  slackIntegrations,
  surveys,
  tableViewPresets,
  traceSessions,
  triggers,
  users,
  verifiedDomains,
  webCalloutEndpoints,
} from "./schema.js";

export const accountRelations = relations(account, ({ one }) => ({
  user: one(users, {
    fields: [account.userId],
    references: [users.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(account),
  sessions: many(session),
  apiKeys: many(apiKeys),
  inAppAgentConversations: many(inAppAgentConversations),
  inAppAgentRuns: many(inAppAgentRuns),
  organizationMemberships: many(organizationMemberships),
  projectMemberships: many(projectMemberships),
  membershipInvitations: many(membershipInvitations),
  annotationQueueItems_annotatorUserId: many(annotationQueueItems, {
    relationName: "annotationQueueItems_annotatorUserId_users_id",
  }),
  annotationQueueItems_lockedByUserId: many(annotationQueueItems, {
    relationName: "annotationQueueItems_lockedByUserId_users_id",
  }),
  annotationQueueAssignments: many(annotationQueueAssignments),
  commentReactions: many(commentReactions),
  notificationPreferences: many(notificationPreferences),
  dashboards_updatedBy: many(dashboards, {
    relationName: "dashboards_updatedBy_users_id",
  }),
  dashboards_createdBy: many(dashboards, {
    relationName: "dashboards_createdBy_users_id",
  }),
  dashboardWidgets_updatedBy: many(dashboardWidgets, {
    relationName: "dashboardWidgets_updatedBy_users_id",
  }),
  dashboardWidgets_createdBy: many(dashboardWidgets, {
    relationName: "dashboardWidgets_createdBy_users_id",
  }),
  tableViewPresets_updatedBy: many(tableViewPresets, {
    relationName: "tableViewPresets_updatedBy_users_id",
  }),
  tableViewPresets_createdBy: many(tableViewPresets, {
    relationName: "tableViewPresets_createdBy_users_id",
  }),
  defaultViews: many(defaultViews),
  monitors_updatedBy: many(monitors, {
    relationName: "monitors_updatedBy_users_id",
  }),
  monitors_createdBy: many(monitors, {
    relationName: "monitors_createdBy_users_id",
  }),
  surveys: many(surveys),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(users, {
    fields: [session.userId],
    references: [users.id],
  }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projects.orgId],
    references: [organizations.id],
  }),
  dashboard: one(dashboards, {
    fields: [projects.homeDashboardId],
    references: [dashboards.id],
    relationName: "projects_homeDashboardId_dashboards_id",
  }),
  apiKeys: many(apiKeys),
  inAppAgentConversations: many(inAppAgentConversations),
  inAppAgentEvents: many(inAppAgentEvents),
  inAppAgentRuns: many(inAppAgentRuns),
  inAppAgentPendingToolApprovals: many(inAppAgentPendingToolApprovals),
  llmApiKeys: many(llmApiKeys),
  projectMemberships: many(projectMemberships),
  membershipInvitations: many(membershipInvitations),
  traceSessions: many(traceSessions),
  scoreConfigs: many(scoreConfigs),
  annotationQueues: many(annotationQueues),
  annotationQueueItems: many(annotationQueueItems),
  annotationQueueAssignments: many(annotationQueueAssignments),
  datasets: many(datasets),
  comments: many(comments),
  commentReactions: many(commentReactions),
  notificationPreferences: many(notificationPreferences),
  prompts: many(prompts),
  promptDependencies: many(promptDependencies),
  promptProtectedLabels: many(promptProtectedLabels),
  models: many(models),
  prices: many(prices),
  evalTemplates: many(evalTemplates),
  jobConfigurations: many(jobConfigurations),
  jobExecutions: many(jobExecutions),
  defaultLlmModels: many(defaultLlmModels),
  posthogIntegrations: many(posthogIntegrations),
  mixpanelIntegrations: many(mixpanelIntegrations),
  blobStorageIntegrations: many(blobStorageIntegrations),
  webCalloutEndpoints: many(webCalloutEndpoints),
  batchExports: many(batchExports),
  batchActions: many(batchActions),
  media: many(media),
  llmSchemas: many(llmSchemas),
  llmTools: many(llmTools),
  dashboards: many(dashboards, {
    relationName: "dashboards_projectId_projects_id",
  }),
  dashboardWidgets: many(dashboardWidgets),
  tableViewPresets: many(tableViewPresets),
  defaultViews: many(defaultViews),
  actions: many(actions),
  triggers: many(triggers),
  automations: many(automations),
  automationExecutions: many(automationExecutions),
  monitors: many(monitors),
  slackIntegrations: many(slackIntegrations),
  pendingDeletions: many(pendingDeletions),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  projects: many(projects),
  apiKeys: many(apiKeys),
  organizationMemberships: many(organizationMemberships),
  membershipInvitations: many(membershipInvitations),
  verifiedDomains: many(verifiedDomains),
  surveys: many(surveys),
  cloudSpendAlerts: many(cloudSpendAlerts),
}));

export const dashboardsRelations = relations(dashboards, ({ one, many }) => ({
  projects: many(projects, {
    relationName: "projects_homeDashboardId_dashboards_id",
  }),
  project: one(projects, {
    fields: [dashboards.projectId],
    references: [projects.id],
    relationName: "dashboards_projectId_projects_id",
  }),
  user_updatedBy: one(users, {
    fields: [dashboards.updatedBy],
    references: [users.id],
    relationName: "dashboards_updatedBy_users_id",
  }),
  user_createdBy: one(users, {
    fields: [dashboards.createdBy],
    references: [users.id],
    relationName: "dashboards_createdBy_users_id",
  }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one, many }) => ({
  apiKey: one(apiKeys, {
    fields: [apiKeys.createdByApiKeyId],
    references: [apiKeys.id],
    relationName: "apiKeys_createdByApiKeyId_apiKeys_id",
  }),
  apiKeys: many(apiKeys, {
    relationName: "apiKeys_createdByApiKeyId_apiKeys_id",
  }),
  user: one(users, {
    fields: [apiKeys.createdByUserId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [apiKeys.organizationId],
    references: [organizations.id],
  }),
  project: one(projects, {
    fields: [apiKeys.projectId],
    references: [projects.id],
  }),
}));

export const inAppAgentConversationsRelations = relations(
  inAppAgentConversations,
  ({ one, many }) => ({
    user: one(users, {
      fields: [inAppAgentConversations.createdByUserId],
      references: [users.id],
    }),
    project: one(projects, {
      fields: [inAppAgentConversations.projectId],
      references: [projects.id],
    }),
    inAppAgentEvents: many(inAppAgentEvents),
    inAppAgentRuns: many(inAppAgentRuns),
    inAppAgentPendingToolApprovals: many(inAppAgentPendingToolApprovals),
  }),
);

export const inAppAgentEventsRelations = relations(inAppAgentEvents, ({ one }) => ({
  inAppAgentRun: one(inAppAgentRuns, {
    fields: [inAppAgentEvents.runId],
    references: [inAppAgentRuns.id],
  }),
  inAppAgentConversation: one(inAppAgentConversations, {
    fields: [inAppAgentEvents.conversationId],
    references: [inAppAgentConversations.id],
  }),
  project: one(projects, {
    fields: [inAppAgentEvents.projectId],
    references: [projects.id],
  }),
}));

export const inAppAgentRunsRelations = relations(inAppAgentRuns, ({ one, many }) => ({
  inAppAgentEvents: many(inAppAgentEvents),
  user: one(users, {
    fields: [inAppAgentRuns.triggeredByUserId],
    references: [users.id],
  }),
  inAppAgentConversation: one(inAppAgentConversations, {
    fields: [inAppAgentRuns.conversationId],
    references: [inAppAgentConversations.id],
  }),
  project: one(projects, {
    fields: [inAppAgentRuns.projectId],
    references: [projects.id],
  }),
}));

export const inAppAgentPendingToolApprovalsRelations = relations(
  inAppAgentPendingToolApprovals,
  ({ one }) => ({
    inAppAgentConversation: one(inAppAgentConversations, {
      fields: [inAppAgentPendingToolApprovals.conversationId],
      references: [inAppAgentConversations.id],
    }),
    project: one(projects, {
      fields: [inAppAgentPendingToolApprovals.projectId],
      references: [projects.id],
    }),
  }),
);

export const llmApiKeysRelations = relations(llmApiKeys, ({ one, many }) => ({
  project: one(projects, {
    fields: [llmApiKeys.projectId],
    references: [projects.id],
  }),
  defaultLlmModels: many(defaultLlmModels),
}));

export const organizationMembershipsRelations = relations(
  organizationMemberships,
  ({ one, many }) => ({
    user: one(users, {
      fields: [organizationMemberships.userId],
      references: [users.id],
    }),
    organization: one(organizations, {
      fields: [organizationMemberships.orgId],
      references: [organizations.id],
    }),
    projectMemberships: many(projectMemberships),
  }),
);

export const projectMembershipsRelations = relations(projectMemberships, ({ one }) => ({
  user: one(users, {
    fields: [projectMemberships.userId],
    references: [users.id],
  }),
  project: one(projects, {
    fields: [projectMemberships.projectId],
    references: [projects.id],
  }),
  organizationMembership: one(organizationMemberships, {
    fields: [projectMemberships.orgMembershipId],
    references: [organizationMemberships.id],
  }),
}));

export const membershipInvitationsRelations = relations(membershipInvitations, ({ one }) => ({
  user: one(users, {
    fields: [membershipInvitations.invitedByUserId],
    references: [users.id],
  }),
  project: one(projects, {
    fields: [membershipInvitations.projectId],
    references: [projects.id],
  }),
  organization: one(organizations, {
    fields: [membershipInvitations.orgId],
    references: [organizations.id],
  }),
}));

export const traceSessionsRelations = relations(traceSessions, ({ one }) => ({
  project: one(projects, {
    fields: [traceSessions.projectId],
    references: [projects.id],
  }),
}));

export const scoreConfigsRelations = relations(scoreConfigs, ({ one }) => ({
  project: one(projects, {
    fields: [scoreConfigs.projectId],
    references: [projects.id],
  }),
}));

export const annotationQueuesRelations = relations(annotationQueues, ({ one, many }) => ({
  project: one(projects, {
    fields: [annotationQueues.projectId],
    references: [projects.id],
  }),
  annotationQueueItems: many(annotationQueueItems),
  annotationQueueAssignments: many(annotationQueueAssignments),
}));

export const annotationQueueItemsRelations = relations(annotationQueueItems, ({ one }) => ({
  project: one(projects, {
    fields: [annotationQueueItems.projectId],
    references: [projects.id],
  }),
  user_annotatorUserId: one(users, {
    fields: [annotationQueueItems.annotatorUserId],
    references: [users.id],
    relationName: "annotationQueueItems_annotatorUserId_users_id",
  }),
  user_lockedByUserId: one(users, {
    fields: [annotationQueueItems.lockedByUserId],
    references: [users.id],
    relationName: "annotationQueueItems_lockedByUserId_users_id",
  }),
  annotationQueue: one(annotationQueues, {
    fields: [annotationQueueItems.queueId],
    references: [annotationQueues.id],
  }),
}));

export const annotationQueueAssignmentsRelations = relations(
  annotationQueueAssignments,
  ({ one }) => ({
    annotationQueue: one(annotationQueues, {
      fields: [annotationQueueAssignments.queueId],
      references: [annotationQueues.id],
    }),
    user: one(users, {
      fields: [annotationQueueAssignments.userId],
      references: [users.id],
    }),
    project: one(projects, {
      fields: [annotationQueueAssignments.projectId],
      references: [projects.id],
    }),
  }),
);

export const datasetsRelations = relations(datasets, ({ one, many }) => ({
  project: one(projects, {
    fields: [datasets.projectId],
    references: [projects.id],
  }),
  datasetItems: many(datasetItems),
  datasetRuns: many(datasetRuns),
}));

export const datasetItemsRelations = relations(datasetItems, ({ one }) => ({
  dataset: one(datasets, {
    fields: [datasetItems.datasetId],
    references: [datasets.id],
  }),
}));

export const datasetRunsRelations = relations(datasetRuns, ({ one }) => ({
  dataset: one(datasets, {
    fields: [datasetRuns.datasetId],
    references: [datasets.id],
  }),
}));

export const commentsRelations = relations(comments, ({ one, many }) => ({
  project: one(projects, {
    fields: [comments.projectId],
    references: [projects.id],
  }),
  commentReactions: many(commentReactions),
}));

export const commentReactionsRelations = relations(commentReactions, ({ one }) => ({
  user: one(users, {
    fields: [commentReactions.userId],
    references: [users.id],
  }),
  comment: one(comments, {
    fields: [commentReactions.commentId],
    references: [comments.id],
  }),
  project: one(projects, {
    fields: [commentReactions.projectId],
    references: [projects.id],
  }),
}));

export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }) => ({
  project: one(projects, {
    fields: [notificationPreferences.projectId],
    references: [projects.id],
  }),
  user: one(users, {
    fields: [notificationPreferences.userId],
    references: [users.id],
  }),
}));

export const promptsRelations = relations(prompts, ({ one, many }) => ({
  project: one(projects, {
    fields: [prompts.projectId],
    references: [projects.id],
  }),
  promptDependencies: many(promptDependencies),
}));

export const promptDependenciesRelations = relations(promptDependencies, ({ one }) => ({
  prompt: one(prompts, {
    fields: [promptDependencies.parentId],
    references: [prompts.id],
  }),
  project: one(projects, {
    fields: [promptDependencies.projectId],
    references: [projects.id],
  }),
}));

export const promptProtectedLabelsRelations = relations(promptProtectedLabels, ({ one }) => ({
  project: one(projects, {
    fields: [promptProtectedLabels.projectId],
    references: [projects.id],
  }),
}));

export const modelsRelations = relations(models, ({ one, many }) => ({
  project: one(projects, {
    fields: [models.projectId],
    references: [projects.id],
  }),
  prices: many(prices),
  pricingTiers: many(pricingTiers),
}));

export const pricesRelations = relations(prices, ({ one }) => ({
  pricingTier: one(pricingTiers, {
    fields: [prices.pricingTierId],
    references: [pricingTiers.id],
  }),
  project: one(projects, {
    fields: [prices.projectId],
    references: [projects.id],
  }),
  model: one(models, {
    fields: [prices.modelId],
    references: [models.id],
  }),
}));

export const pricingTiersRelations = relations(pricingTiers, ({ one, many }) => ({
  prices: many(prices),
  model: one(models, {
    fields: [pricingTiers.modelId],
    references: [models.id],
  }),
}));

export const evalTemplatesRelations = relations(evalTemplates, ({ one, many }) => ({
  project: one(projects, {
    fields: [evalTemplates.projectId],
    references: [projects.id],
  }),
  jobConfigurations: many(jobConfigurations),
}));

export const jobConfigurationsRelations = relations(jobConfigurations, ({ one, many }) => ({
  evalTemplate: one(evalTemplates, {
    fields: [jobConfigurations.evalTemplateId],
    references: [evalTemplates.id],
  }),
  project: one(projects, {
    fields: [jobConfigurations.projectId],
    references: [projects.id],
  }),
  jobExecutions: many(jobExecutions),
}));

export const jobExecutionsRelations = relations(jobExecutions, ({ one }) => ({
  jobConfiguration: one(jobConfigurations, {
    fields: [jobExecutions.jobConfigurationId],
    references: [jobConfigurations.id],
  }),
  project: one(projects, {
    fields: [jobExecutions.projectId],
    references: [projects.id],
  }),
}));

export const defaultLlmModelsRelations = relations(defaultLlmModels, ({ one }) => ({
  llmApiKey: one(llmApiKeys, {
    fields: [defaultLlmModels.llmApiKeyId],
    references: [llmApiKeys.id],
  }),
  project: one(projects, {
    fields: [defaultLlmModels.projectId],
    references: [projects.id],
  }),
}));

export const verifiedDomainsRelations = relations(verifiedDomains, ({ one }) => ({
  organization: one(organizations, {
    fields: [verifiedDomains.organizationId],
    references: [organizations.id],
  }),
}));

export const posthogIntegrationsRelations = relations(posthogIntegrations, ({ one }) => ({
  project: one(projects, {
    fields: [posthogIntegrations.projectId],
    references: [projects.id],
  }),
}));

export const mixpanelIntegrationsRelations = relations(mixpanelIntegrations, ({ one }) => ({
  project: one(projects, {
    fields: [mixpanelIntegrations.projectId],
    references: [projects.id],
  }),
}));

export const blobStorageIntegrationsRelations = relations(blobStorageIntegrations, ({ one }) => ({
  project: one(projects, {
    fields: [blobStorageIntegrations.projectId],
    references: [projects.id],
  }),
}));

export const webCalloutEndpointsRelations = relations(webCalloutEndpoints, ({ one }) => ({
  project: one(projects, {
    fields: [webCalloutEndpoints.projectId],
    references: [projects.id],
  }),
}));

export const batchExportsRelations = relations(batchExports, ({ one }) => ({
  project: one(projects, {
    fields: [batchExports.projectId],
    references: [projects.id],
  }),
}));

export const batchActionsRelations = relations(batchActions, ({ one }) => ({
  project: one(projects, {
    fields: [batchActions.projectId],
    references: [projects.id],
  }),
}));

export const mediaRelations = relations(media, ({ one }) => ({
  project: one(projects, {
    fields: [media.projectId],
    references: [projects.id],
  }),
}));

export const llmSchemasRelations = relations(llmSchemas, ({ one }) => ({
  project: one(projects, {
    fields: [llmSchemas.projectId],
    references: [projects.id],
  }),
}));

export const llmToolsRelations = relations(llmTools, ({ one }) => ({
  project: one(projects, {
    fields: [llmTools.projectId],
    references: [projects.id],
  }),
}));

export const dashboardWidgetsRelations = relations(dashboardWidgets, ({ one }) => ({
  project: one(projects, {
    fields: [dashboardWidgets.projectId],
    references: [projects.id],
  }),
  user_updatedBy: one(users, {
    fields: [dashboardWidgets.updatedBy],
    references: [users.id],
    relationName: "dashboardWidgets_updatedBy_users_id",
  }),
  user_createdBy: one(users, {
    fields: [dashboardWidgets.createdBy],
    references: [users.id],
    relationName: "dashboardWidgets_createdBy_users_id",
  }),
}));

export const tableViewPresetsRelations = relations(tableViewPresets, ({ one }) => ({
  user_updatedBy: one(users, {
    fields: [tableViewPresets.updatedBy],
    references: [users.id],
    relationName: "tableViewPresets_updatedBy_users_id",
  }),
  user_createdBy: one(users, {
    fields: [tableViewPresets.createdBy],
    references: [users.id],
    relationName: "tableViewPresets_createdBy_users_id",
  }),
  project: one(projects, {
    fields: [tableViewPresets.projectId],
    references: [projects.id],
  }),
}));

export const defaultViewsRelations = relations(defaultViews, ({ one }) => ({
  user: one(users, {
    fields: [defaultViews.userId],
    references: [users.id],
  }),
  project: one(projects, {
    fields: [defaultViews.projectId],
    references: [projects.id],
  }),
}));

export const actionsRelations = relations(actions, ({ one, many }) => ({
  project: one(projects, {
    fields: [actions.projectId],
    references: [projects.id],
  }),
  automations: many(automations),
  automationExecutions: many(automationExecutions),
}));

export const triggersRelations = relations(triggers, ({ one, many }) => ({
  project: one(projects, {
    fields: [triggers.projectId],
    references: [projects.id],
  }),
  automations: many(automations),
  automationExecutions: many(automationExecutions),
}));

export const automationsRelations = relations(automations, ({ one, many }) => ({
  project: one(projects, {
    fields: [automations.projectId],
    references: [projects.id],
  }),
  action: one(actions, {
    fields: [automations.actionId],
    references: [actions.id],
  }),
  trigger: one(triggers, {
    fields: [automations.triggerId],
    references: [triggers.id],
  }),
  automationExecutions: many(automationExecutions),
}));

export const automationExecutionsRelations = relations(automationExecutions, ({ one }) => ({
  project: one(projects, {
    fields: [automationExecutions.projectId],
    references: [projects.id],
  }),
  action: one(actions, {
    fields: [automationExecutions.actionId],
    references: [actions.id],
  }),
  trigger: one(triggers, {
    fields: [automationExecutions.triggerId],
    references: [triggers.id],
  }),
  automation: one(automations, {
    fields: [automationExecutions.automationId],
    references: [automations.id],
  }),
}));

export const monitorsRelations = relations(monitors, ({ one }) => ({
  project: one(projects, {
    fields: [monitors.projectId],
    references: [projects.id],
  }),
  user_updatedBy: one(users, {
    fields: [monitors.updatedBy],
    references: [users.id],
    relationName: "monitors_updatedBy_users_id",
  }),
  user_createdBy: one(users, {
    fields: [monitors.createdBy],
    references: [users.id],
    relationName: "monitors_createdBy_users_id",
  }),
}));

export const slackIntegrationsRelations = relations(slackIntegrations, ({ one }) => ({
  project: one(projects, {
    fields: [slackIntegrations.projectId],
    references: [projects.id],
  }),
}));

export const pendingDeletionsRelations = relations(pendingDeletions, ({ one }) => ({
  project: one(projects, {
    fields: [pendingDeletions.projectId],
    references: [projects.id],
  }),
}));

export const surveysRelations = relations(surveys, ({ one }) => ({
  user: one(users, {
    fields: [surveys.userId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [surveys.orgId],
    references: [organizations.id],
  }),
}));

export const cloudSpendAlertsRelations = relations(cloudSpendAlerts, ({ one }) => ({
  organization: one(organizations, {
    fields: [cloudSpendAlerts.orgId],
    references: [organizations.id],
  }),
}));
