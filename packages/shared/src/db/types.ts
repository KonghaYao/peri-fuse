/**
 * Model type compatibility layer.
 *
 * Previously these types came from `export * from "@prisma/client"`. They are
 * now inferred from the Drizzle table definitions so the rest of the codebase
 * can keep importing the same PascalCase model names (User, ApiKey, Project…).
 *
 *   X        -> row shape   (InferSelectModel)  — replaces Prisma's `X`
 *   XCreateInput / XUncheckedCreateInput -> insert shape (InferInsertModel)
 *
 * Field types match the Prisma SQLite defaults: DateTime -> Date, Boolean ->
 * boolean, Int/BigInt -> number, Float/Decimal -> number, String -> string,
 * Json -> string (stored as TEXT).
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type {
  account,
  actions,
  annotationQueueAssignments,
  annotationQueueItems,
  annotationQueues,
  apiKeys,
  auditLogs,
  automationExecutions,
  automations,
  backgroundMigrations,
  batchActions,
  batchExports,
  billingMeterBackups,
  blobStorageIntegrations,
  cloudSpendAlerts,
  commentReactions,
  comments,
  cronJobs,
  dashboards,
  dashboardWidgets,
  datasetItemMedia,
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
  observationMedia,
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
  ssoConfigs,
  surveys,
  tableViewPresets,
  traceMedia,
  traceSessions,
  triggers,
  users,
  verificationTokens,
  verifiedDomains,
  webCalloutEndpoints,
} from "./schema/index.js";

// ── row (select) types ──────────────────────────────────────────────
export type Account = InferSelectModel<typeof account>;
export type Session = InferSelectModel<typeof session>;
export type User = InferSelectModel<typeof users>;
export type VerificationToken = InferSelectModel<typeof verificationTokens>;
export type Organization = InferSelectModel<typeof organizations>;
export type Project = InferSelectModel<typeof projects>;
export type ApiKey = InferSelectModel<typeof apiKeys>;
export type InAppAgentConversation = InferSelectModel<typeof inAppAgentConversations>;
export type InAppAgentEvent = InferSelectModel<typeof inAppAgentEvents>;
export type InAppAgentRun = InferSelectModel<typeof inAppAgentRuns>;
export type InAppAgentPendingToolApproval = InferSelectModel<typeof inAppAgentPendingToolApprovals>;
export type BackgroundMigration = InferSelectModel<typeof backgroundMigrations>;
export type LlmApiKeys = InferSelectModel<typeof llmApiKeys>;
export type OrganizationMembership = InferSelectModel<typeof organizationMemberships>;
export type ProjectMembership = InferSelectModel<typeof projectMemberships>;
export type MembershipInvitation = InferSelectModel<typeof membershipInvitations>;
export type TraceSession = InferSelectModel<typeof traceSessions>;
export type ScoreConfig = InferSelectModel<typeof scoreConfigs>;
export type AnnotationQueue = InferSelectModel<typeof annotationQueues>;
export type AnnotationQueueItem = InferSelectModel<typeof annotationQueueItems>;
export type AnnotationQueueAssignment = InferSelectModel<typeof annotationQueueAssignments>;
export type CronJobs = InferSelectModel<typeof cronJobs>;
export type Dataset = InferSelectModel<typeof datasets>;
export type DatasetItem = InferSelectModel<typeof datasetItems>;
export type DatasetRuns = InferSelectModel<typeof datasetRuns>;
export type Comment = InferSelectModel<typeof comments>;
export type CommentReaction = InferSelectModel<typeof commentReactions>;
export type NotificationPreference = InferSelectModel<typeof notificationPreferences>;
export type Prompt = InferSelectModel<typeof prompts>;
export type PromptDependency = InferSelectModel<typeof promptDependencies>;
export type PromptProtectedLabels = InferSelectModel<typeof promptProtectedLabels>;
export type Model = InferSelectModel<typeof models>;
export type Price = InferSelectModel<typeof prices>;
export type PricingTier = InferSelectModel<typeof pricingTiers>;
export type AuditLog = InferSelectModel<typeof auditLogs>;
export type EvalTemplate = InferSelectModel<typeof evalTemplates>;
export type JobConfiguration = InferSelectModel<typeof jobConfigurations>;
export type JobExecution = InferSelectModel<typeof jobExecutions>;
export type DefaultLlmModel = InferSelectModel<typeof defaultLlmModels>;
export type SsoConfig = InferSelectModel<typeof ssoConfigs>;
export type VerifiedDomain = InferSelectModel<typeof verifiedDomains>;
export type PosthogIntegration = InferSelectModel<typeof posthogIntegrations>;
export type MixpanelIntegration = InferSelectModel<typeof mixpanelIntegrations>;
export type BlobStorageIntegration = InferSelectModel<typeof blobStorageIntegrations>;
export type WebCalloutEndpoint = InferSelectModel<typeof webCalloutEndpoints>;
export type BatchExport = InferSelectModel<typeof batchExports>;
export type BatchAction = InferSelectModel<typeof batchActions>;
export type Media = InferSelectModel<typeof media>;
export type TraceMedia = InferSelectModel<typeof traceMedia>;
export type ObservationMedia = InferSelectModel<typeof observationMedia>;
export type DatasetItemMedia = InferSelectModel<typeof datasetItemMedia>;
export type BillingMeterBackup = InferSelectModel<typeof billingMeterBackups>;
export type LlmSchema = InferSelectModel<typeof llmSchemas>;
export type LlmTool = InferSelectModel<typeof llmTools>;
export type Dashboard = InferSelectModel<typeof dashboards>;
export type DashboardWidget = InferSelectModel<typeof dashboardWidgets>;
export type TableViewPreset = InferSelectModel<typeof tableViewPresets>;
export type DefaultView = InferSelectModel<typeof defaultViews>;
export type Action = InferSelectModel<typeof actions>;
export type Trigger = InferSelectModel<typeof triggers>;
export type Automation = InferSelectModel<typeof automations>;
export type AutomationExecution = InferSelectModel<typeof automationExecutions>;
export type Monitor = InferSelectModel<typeof monitors>;
export type SlackIntegration = InferSelectModel<typeof slackIntegrations>;
export type PendingDeletion = InferSelectModel<typeof pendingDeletions>;
export type Survey = InferSelectModel<typeof surveys>;
export type CloudSpendAlert = InferSelectModel<typeof cloudSpendAlerts>;

// ── insert (create) types ───────────────────────────────────────────
export type AccountCreateInput = InferInsertModel<typeof account>;
export type AccountUncheckedCreateInput = InferInsertModel<typeof account>;
export type SessionCreateInput = InferInsertModel<typeof session>;
export type SessionUncheckedCreateInput = InferInsertModel<typeof session>;
export type UserCreateInput = InferInsertModel<typeof users>;
export type UserUncheckedCreateInput = InferInsertModel<typeof users>;
export type VerificationTokenCreateInput = InferInsertModel<typeof verificationTokens>;
export type OrganizationCreateInput = InferInsertModel<typeof organizations>;
export type OrganizationUncheckedCreateInput = InferInsertModel<typeof organizations>;
export type ProjectCreateInput = InferInsertModel<typeof projects>;
export type ProjectUncheckedCreateInput = InferInsertModel<typeof projects>;
export type ApiKeyCreateInput = InferInsertModel<typeof apiKeys>;
export type ApiKeyUncheckedCreateInput = InferInsertModel<typeof apiKeys>;
export type OrganizationMembershipCreateInput = InferInsertModel<typeof organizationMemberships>;
export type ProjectMembershipCreateInput = InferInsertModel<typeof projectMemberships>;
export type MembershipInvitationCreateInput = InferInsertModel<typeof membershipInvitations>;
export type ScoreConfigCreateInput = InferInsertModel<typeof scoreConfigs>;
export type DatasetCreateInput = InferInsertModel<typeof datasets>;
export type DatasetItemCreateInput = InferInsertModel<typeof datasetItems>;
export type DatasetRunsCreateInput = InferInsertModel<typeof datasetRuns>;
export type CommentCreateInput = InferInsertModel<typeof comments>;
export type PromptCreateInput = InferInsertModel<typeof prompts>;
export type ModelCreateInput = InferInsertModel<typeof models>;
export type PriceCreateInput = InferInsertModel<typeof prices>;
export type PricingTierCreateInput = InferInsertModel<typeof pricingTiers>;
export type EvalTemplateCreateInput = InferInsertModel<typeof evalTemplates>;
export type JobConfigurationCreateInput = InferInsertModel<typeof jobConfigurations>;
export type JobExecutionCreateInput = InferInsertModel<typeof jobExecutions>;
export type BatchExportCreateInput = InferInsertModel<typeof batchExports>;
export type DashboardCreateInput = InferInsertModel<typeof dashboards>;
export type DashboardWidgetCreateInput = InferInsertModel<typeof dashboardWidgets>;
export type TableViewPresetCreateInput = InferInsertModel<typeof tableViewPresets>;
export type DefaultViewCreateInput = InferInsertModel<typeof defaultViews>;
export type ActionCreateInput = InferInsertModel<typeof actions>;
export type TriggerCreateInput = InferInsertModel<typeof triggers>;
export type AutomationCreateInput = InferInsertModel<typeof automations>;
export type AutomationExecutionCreateInput = InferInsertModel<typeof automationExecutions>;
export type MonitorCreateInput = InferInsertModel<typeof monitors>;
export type SurveyCreateInput = InferInsertModel<typeof surveys>;
export type TraceSessionCreateInput = InferInsertModel<typeof traceSessions>;
export type LlmApiKeysCreateInput = InferInsertModel<typeof llmApiKeys>;
export type BackgroundMigrationCreateInput = InferInsertModel<typeof backgroundMigrations>;
export type AuditLogCreateInput = InferInsertModel<typeof auditLogs>;
export type MediaCreateInput = InferInsertModel<typeof media>;
export type SlackIntegrationCreateInput = InferInsertModel<typeof slackIntegrations>;
