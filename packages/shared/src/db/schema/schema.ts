import { sqliteTable, AnySQLiteColumn, uniqueIndex, index, foreignKey, text, integer, primaryKey, real } from "drizzle-orm/sqlite-core"

export const account = sqliteTable("Account", {
	id: text().primaryKey().notNull(),
	userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	type: text().notNull(),
	provider: text().notNull(),
	providerAccountId: text().notNull(),
	refreshToken: text("refresh_token"),
	accessToken: text("access_token"),
	expiresAt: integer("expires_at"),
	expiresIn: integer("expires_in"),
	extExpiresIn: integer("ext_expires_in"),
	tokenType: text("token_type"),
	scope: text(),
	idToken: text("id_token"),
	sessionState: text("session_state"),
	refreshTokenExpiresIn: integer("refresh_token_expires_in"),
	createdAt: integer("created_at"),
},
(table) => [
	uniqueIndex("Account_provider_providerAccountId_key").on(table.provider, table.providerAccountId),
	index("Account_user_id_idx").on(table.userId),
]);

export const session = sqliteTable("Session", {
	id: text().primaryKey().notNull(),
	sessionToken: text("session_token").notNull(),
	userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
},
(table) => [
	uniqueIndex("Session_session_token_key").on(table.sessionToken),
]);

export const users = sqliteTable("users", {
	id: text().primaryKey().notNull(),
	name: text(),
	email: text(),
	emailVerified: integer("email_verified", { mode: "timestamp_ms" }),
	password: text(),
	image: text(),
	admin: integer("admin", { mode: "boolean" }).default(false).notNull(),
	v4BetaEnabled: integer("v4_beta_enabled", { mode: "boolean" }).default(false).notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	featureFlags: text("feature_flags").default("[]").notNull(),
},
(table) => [
	uniqueIndex("users_email_key").on(table.email),
]);

export const verificationTokens = sqliteTable("verification_tokens", {
	identifier: text().notNull(),
	token: text().notNull(),
	expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
},
(table) => [
	uniqueIndex("verification_tokens_identifier_token_key").on(table.identifier, table.token),
	uniqueIndex("verification_tokens_token_key").on(table.token),
]);

export const organizations = sqliteTable("organizations", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	cloudConfig: text("cloud_config"),
	metadata: text(),
	cloudBillingCycleAnchor: integer("cloud_billing_cycle_anchor", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
	cloudBillingCycleUpdatedAt: integer("cloud_billing_cycle_updated_at", { mode: "timestamp_ms" }),
	cloudCurrentCycleUsage: integer("cloud_current_cycle_usage"),
	cloudFreeTierUsageThresholdState: text("cloud_free_tier_usage_threshold_state"),
	aiFeaturesEnabled: integer("ai_features_enabled", { mode: "boolean" }).default(false).notNull(),
	aiTelemetryEnabled: integer("ai_telemetry_enabled", { mode: "boolean" }).default(true).notNull(),
	sfdcOrgId: text("sfdc_org_id"),
});

export const projects = sqliteTable("projects", {
	id: text().primaryKey().notNull(),
	orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
	name: text().notNull(),
	retentionDays: integer("retention_days"),
	hasTraces: integer("has_traces", { mode: "boolean" }).default(false).notNull(),
	metadata: text(),
	homeDashboardId: text("home_dashboard_id").references((): AnySQLiteColumn => dashboards.id, { onDelete: "set null", onUpdate: "cascade" } ),
},
(table) => [
	index("projects_org_id_idx").on(table.orgId),
]);

export const apiKeys = sqliteTable("api_keys", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	note: text(),
	publicKey: text("public_key").notNull(),
	hashedSecretKey: text("hashed_secret_key").notNull(),
	fastHashedSecretKey: text("fast_hashed_secret_key"),
	displaySecretKey: text("display_secret_key").notNull(),
	lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
	isInAppAgentKey: integer("is_in_app_agent_key", { mode: "boolean" }).default(false).notNull(),
	projectId: text("project_id").references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	scope: text().default("PROJECT").notNull(),
	createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" } ),
	createdByApiKeyId: text("created_by_api_key_id"),
},
(table) => [
	index("api_keys_fast_hashed_secret_key_idx").on(table.fastHashedSecretKey),
	index("api_keys_hashed_secret_key_idx").on(table.hashedSecretKey),
	index("api_keys_public_key_idx").on(table.publicKey),
	index("api_keys_created_by_api_key_id_idx").on(table.createdByApiKeyId),
	index("api_keys_project_id_idx").on(table.projectId),
	index("api_keys_organization_id_idx").on(table.organizationId),
	uniqueIndex("api_keys_fast_hashed_secret_key_key").on(table.fastHashedSecretKey),
	uniqueIndex("api_keys_hashed_secret_key_key").on(table.hashedSecretKey),
	uniqueIndex("api_keys_public_key_key").on(table.publicKey),
	uniqueIndex("api_keys_id_key").on(table.id),
	foreignKey(() => ({
			columns: [table.createdByApiKeyId],
			foreignColumns: [table.id],
			name: "api_keys_created_by_api_key_id_api_keys_id_fk"
		})).onUpdate("cascade").onDelete("set null"),
]);

export const inAppAgentConversations = sqliteTable("in_app_agent_conversations", {
	id: text().notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" } ),
	title: text(),
	renamedByUserAt: integer("renamed_by_user_at", { mode: "timestamp_ms" }),
	visibilityScope: text("visibility_scope").default("PERSONAL").notNull(),
	providerSessionId: text("provider_session_id"),
	deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
},
(table) => [
	index("in_app_agent_conversations_project_user_list_idx").on(table.projectId, table.createdByUserId, table.deletedAt, table.updatedAt, table.id),
	primaryKey({ columns: [table.id, table.projectId], name: "in_app_agent_conversations_id_project_id_pk"})
]);

export const inAppAgentEvents = sqliteTable("in_app_agent_events", {
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	conversationId: text("conversation_id").notNull(),
	runId: text("run_id").notNull(),
	sequenceNumber: integer("sequence_number").notNull(),
	type: text().notNull(),
	event: text().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
},
(table) => [
	index("in_app_agent_events_project_run_idx").on(table.projectId, table.runId),
	foreignKey(() => ({
			columns: [table.runId, table.projectId],
			foreignColumns: [inAppAgentRuns.id, inAppAgentRuns.projectId],
			name: "in_app_agent_events_run_id_project_id_in_app_agent_runs_id_project_id_fk"
		})).onUpdate("cascade").onDelete("cascade"),
	foreignKey(() => ({
			columns: [table.conversationId, table.projectId],
			foreignColumns: [inAppAgentConversations.id, inAppAgentConversations.projectId],
			name: "in_app_agent_events_conversation_id_project_id_in_app_agent_conversations_id_project_id_fk"
		})).onUpdate("cascade").onDelete("cascade"),
	primaryKey({ columns: [table.projectId, table.conversationId, table.sequenceNumber], name: "in_app_agent_events_project_id_conversation_id_sequence_number_pk"})
]);

export const inAppAgentRuns = sqliteTable("in_app_agent_runs", {
	id: text().notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	conversationId: text("conversation_id").notNull(),
	triggeredByUserId: text("triggered_by_user_id").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" } ),
	model: text(),
	mcpApiKeyId: text("mcp_api_key_id"),
	errorCode: text("error_code"),
	errorMessage: text("error_message"),
	finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
	status: text(),
	request: text(),
	claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
	heartbeatAt: integer("heartbeat_at", { mode: "timestamp_ms" }),
	cancelRequestedAt: integer("cancel_requested_at", { mode: "timestamp_ms" }),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
},
(table) => [
	index("in_app_agent_runs_project_conversation_created_idx").on(table.projectId, table.conversationId, table.createdAt),
	foreignKey(() => ({
			columns: [table.conversationId, table.projectId],
			foreignColumns: [inAppAgentConversations.id, inAppAgentConversations.projectId],
			name: "in_app_agent_runs_conversation_id_project_id_in_app_agent_conversations_id_project_id_fk"
		})).onUpdate("cascade").onDelete("cascade"),
	primaryKey({ columns: [table.id, table.projectId], name: "in_app_agent_runs_id_project_id_pk"})
]);

export const inAppAgentPendingToolApprovals = sqliteTable("in_app_agent_pending_tool_approvals", {
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	conversationId: text("conversation_id").notNull(),
	toolCallId: text("tool_call_id").notNull(),
	approvalFingerprint: text("approval_fingerprint").notNull(),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
},
(table) => [
	index("in_app_agent_pending_tool_approvals_expires_at_idx").on(table.expiresAt),
	foreignKey(() => ({
			columns: [table.conversationId, table.projectId],
			foreignColumns: [inAppAgentConversations.id, inAppAgentConversations.projectId],
			name: "in_app_agent_pending_tool_approvals_conversation_id_project_id_in_app_agent_conversations_id_project_id_fk"
		})).onUpdate("cascade").onDelete("cascade"),
	primaryKey({ columns: [table.projectId, table.conversationId, table.toolCallId], name: "in_app_agent_pending_tool_approvals_project_id_conversation_id_tool_call_id_pk"})
]);

export const backgroundMigrations = sqliteTable("background_migrations", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	script: text().notNull(),
	args: text().notNull(),
	state: text().default("{}").notNull(),
	finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
	failedAt: integer("failed_at", { mode: "timestamp_ms" }),
	failedReason: text("failed_reason"),
	workerId: text("worker_id"),
	lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
},
(table) => [
	uniqueIndex("background_migrations_name_key").on(table.name),
]);

export const llmApiKeys = sqliteTable("llm_api_keys", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	provider: text().notNull(),
	adapter: text().notNull(),
	displaySecretKey: text("display_secret_key").notNull(),
	secretKey: text("secret_key").notNull(),
	baseUrl: text("base_url"),
	customModels: text("custom_models").default("[]").notNull(),
	withDefaultModels: integer("with_default_models", { mode: "boolean" }).default(true).notNull(),
	extraHeaders: text("extra_headers"),
	extraHeaderKeys: text("extra_header_keys").default("[]").notNull(),
	config: text(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
},
(table) => [
	uniqueIndex("llm_api_keys_project_id_provider_key").on(table.projectId, table.provider),
	uniqueIndex("llm_api_keys_id_key").on(table.id),
]);

export const organizationMemberships = sqliteTable("organization_memberships", {
	id: text().primaryKey().notNull(),
	orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	role: text().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
},
(table) => [
	uniqueIndex("organization_memberships_org_id_user_id_key").on(table.orgId, table.userId),
	index("organization_memberships_user_id_idx").on(table.userId),
]);

export const projectMemberships = sqliteTable("project_memberships", {
	orgMembershipId: text("org_membership_id").notNull().references(() => organizationMemberships.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	role: text().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
},
(table) => [
	index("project_memberships_org_membership_id_idx").on(table.orgMembershipId),
	index("project_memberships_project_id_idx").on(table.projectId),
	index("project_memberships_user_id_idx").on(table.userId),
	primaryKey({ columns: [table.projectId, table.userId], name: "project_memberships_project_id_user_id_pk"})
]);

export const membershipInvitations = sqliteTable("membership_invitations", {
	id: text().primaryKey().notNull(),
	email: text().notNull(),
	orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	orgRole: text("org_role").notNull(),
	projectId: text("project_id").references(() => projects.id, { onDelete: "set null", onUpdate: "cascade" } ),
	projectRole: text("project_role"),
	invitedByUserId: text("invited_by_user_id").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" } ),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
},
(table) => [
	uniqueIndex("membership_invitations_email_org_id_key").on(table.email, table.orgId),
	index("membership_invitations_email_idx").on(table.email),
	index("membership_invitations_org_id_idx").on(table.orgId),
	index("membership_invitations_project_id_idx").on(table.projectId),
	uniqueIndex("membership_invitations_id_key").on(table.id),
]);

export const traceSessions = sqliteTable("trace_sessions", {
	id: text().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	bookmarked: integer("bookmarked", { mode: "boolean" }).default(false).notNull(),
	public: integer("public", { mode: "boolean" }).default(false).notNull(),
	environment: text().default("default").notNull(),
},
(table) => [
	index("trace_sessions_project_id_created_at_idx").on(table.projectId, table.createdAt),
	primaryKey({ columns: [table.id, table.projectId], name: "trace_sessions_id_project_id_pk"})
]);

export const scoreConfigs = sqliteTable("score_configs", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	name: text().notNull(),
	dataType: text("data_type").notNull(),
	isArchived: integer("is_archived", { mode: "boolean" }).default(false).notNull(),
	minValue: real("min_value"),
	maxValue: real("max_value"),
	categories: text(),
	description: text(),
},
(table) => [
	uniqueIndex("score_configs_id_project_id_key").on(table.id, table.projectId),
	index("score_configs_updated_at_idx").on(table.updatedAt),
	index("score_configs_created_at_idx").on(table.createdAt),
	index("score_configs_categories_idx").on(table.categories),
	index("score_configs_project_id_idx").on(table.projectId),
	index("score_configs_is_archived_idx").on(table.isArchived),
	index("score_configs_data_type_idx").on(table.dataType),
]);

export const annotationQueues = sqliteTable("annotation_queues", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	description: text(),
	scoreConfigIds: text("score_config_ids").default("[]").notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
},
(table) => [
	uniqueIndex("annotation_queues_project_id_name_key").on(table.projectId, table.name),
	index("annotation_queues_project_id_created_at_idx").on(table.projectId, table.createdAt),
	index("annotation_queues_id_project_id_idx").on(table.id, table.projectId),
]);

export const annotationQueueItems = sqliteTable("annotation_queue_items", {
	id: text().primaryKey().notNull(),
	queueId: text("queue_id").notNull().references(() => annotationQueues.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	objectId: text("object_id").notNull(),
	objectType: text("object_type").notNull(),
	status: text().default("PENDING").notNull(),
	lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
	lockedByUserId: text("locked_by_user_id").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" } ),
	annotatorUserId: text("annotator_user_id").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" } ),
	completedAt: integer("completed_at", { mode: "timestamp_ms" }),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
},
(table) => [
	index("annotation_queue_items_created_at_idx").on(table.createdAt),
	index("annotation_queue_items_annotator_user_id_idx").on(table.annotatorUserId),
	index("annotation_queue_items_object_id_object_type_project_id_queue_id_idx").on(table.objectId, table.objectType, table.projectId, table.queueId),
	index("annotation_queue_items_project_id_queue_id_status_idx").on(table.projectId, table.queueId, table.status),
	index("annotation_queue_items_id_project_id_idx").on(table.id, table.projectId),
]);

export const annotationQueueAssignments = sqliteTable("annotation_queue_assignments", {
	id: text().primaryKey().notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	queueId: text("queue_id").notNull().references(() => annotationQueues.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
},
(table) => [
	uniqueIndex("annotation_queue_assignments_project_id_queue_id_user_id_key").on(table.projectId, table.queueId, table.userId),
]);

export const cronJobs = sqliteTable("cron_jobs", {
	name: text().primaryKey().notNull(),
	lastRun: integer("last_run", { mode: "timestamp_ms" }),
	jobStartedAt: integer("job_started_at", { mode: "timestamp_ms" }),
	state: text(),
});

export const datasets = sqliteTable("datasets", {
	id: text().notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	name: text().notNull(),
	description: text(),
	metadata: text(),
	remoteExperimentUrl: text("remote_experiment_url"),
	remoteExperimentPayload: text("remote_experiment_payload"),
	remoteExperimentEnabled: integer("remote_experiment_enabled", { mode: "boolean" }).default(true).notNull(),
	inputSchema: text("input_schema"),
	expectedOutputSchema: text("expected_output_schema"),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
},
(table) => [
	uniqueIndex("datasets_project_id_name_key").on(table.projectId, table.name),
	index("datasets_updated_at_idx").on(table.updatedAt),
	index("datasets_created_at_idx").on(table.createdAt),
	primaryKey({ columns: [table.id, table.projectId], name: "datasets_id_project_id_pk"})
]);

export const datasetItems = sqliteTable("dataset_items", {
	id: text().notNull(),
	projectId: text("project_id").notNull(),
	status: text().default("ACTIVE"),
	input: text(),
	expectedOutput: text("expected_output"),
	metadata: text(),
	sourceTraceId: text("source_trace_id"),
	sourceObservationId: text("source_observation_id"),
	datasetId: text("dataset_id").notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	validFrom: integer("valid_from", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	validTo: integer("valid_to", { mode: "timestamp_ms" }),
	isDeleted: integer("is_deleted", { mode: "boolean" }).default(false).notNull(),
},
(table) => [
	index("dataset_items_updated_at_idx").on(table.updatedAt),
	index("dataset_items_created_at_idx").on(table.createdAt),
	index("dataset_items_dataset_id_idx").on(table.datasetId),
	index("dataset_items_source_observation_id_idx").on(table.sourceObservationId),
	index("dataset_items_source_trace_id_idx").on(table.sourceTraceId),
	index("dataset_items_project_id_id_valid_from_idx").on(table.projectId, table.id, table.validFrom),
	index("dataset_items_project_id_valid_to_idx").on(table.projectId, table.validTo),
	foreignKey(() => ({
			columns: [table.datasetId, table.projectId],
			foreignColumns: [datasets.id, datasets.projectId],
			name: "dataset_items_dataset_id_project_id_datasets_id_project_id_fk"
		})).onUpdate("cascade").onDelete("cascade"),
	primaryKey({ columns: [table.id, table.projectId, table.validFrom], name: "dataset_items_id_project_id_valid_from_pk"})
]);

export const datasetRuns = sqliteTable("dataset_runs", {
	id: text().notNull(),
	projectId: text("project_id").notNull(),
	name: text().notNull(),
	description: text(),
	metadata: text(),
	datasetId: text("dataset_id").notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
},
(table) => [
	uniqueIndex("dataset_runs_dataset_id_project_id_name_key").on(table.datasetId, table.projectId, table.name),
	index("dataset_runs_updated_at_idx").on(table.updatedAt),
	index("dataset_runs_created_at_idx").on(table.createdAt),
	index("dataset_runs_dataset_id_idx").on(table.datasetId),
	foreignKey(() => ({
			columns: [table.datasetId, table.projectId],
			foreignColumns: [datasets.id, datasets.projectId],
			name: "dataset_runs_dataset_id_project_id_datasets_id_project_id_fk"
		})).onUpdate("cascade").onDelete("cascade"),
	primaryKey({ columns: [table.id, table.projectId], name: "dataset_runs_id_project_id_pk"})
]);

export const comments = sqliteTable("comments", {
	id: text().primaryKey().notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	objectType: text("object_type").notNull(),
	objectId: text("object_id").notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	content: text().notNull(),
	authorUserId: text("author_user_id"),
	dataField: text("data_field"),
	path: text().default("[]").notNull(),
	rangeStart: text("range_start").default("[]").notNull(),
	rangeEnd: text("range_end").default("[]").notNull(),
},
(table) => [
	index("comments_project_id_object_type_object_id_idx").on(table.projectId, table.objectType, table.objectId),
]);

export const commentReactions = sqliteTable("comment_reactions", {
	id: text().primaryKey().notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	commentId: text("comment_id").notNull().references(() => comments.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	emoji: text().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
},
(table) => [
	uniqueIndex("comment_reactions_comment_id_user_id_emoji_key").on(table.commentId, table.userId, table.emoji),
]);

export const notificationPreferences = sqliteTable("notification_preferences", {
	id: text().primaryKey().notNull(),
	userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	channel: text().notNull(),
	type: text().notNull(),
	enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
},
(table) => [
	uniqueIndex("notification_preferences_user_id_project_id_channel_type_key").on(table.userId, table.projectId, table.channel, table.type),
]);

export const prompts = sqliteTable("prompts", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	createdBy: text("created_by").notNull(),
	prompt: text().notNull(),
	name: text().notNull(),
	version: integer().notNull(),
	type: text().default("text").notNull(),
	isActive: integer("is_active", { mode: "boolean" }),
	config: text().default("{}").notNull(),
	tags: text().default("[]").notNull(),
	labels: text().default("[]").notNull(),
	commitMessage: text("commit_message"),
},
(table) => [
	uniqueIndex("prompts_project_id_name_version_key").on(table.projectId, table.name, table.version),
	index("prompts_tags_idx").on(table.tags),
	index("prompts_updated_at_idx").on(table.updatedAt),
	index("prompts_created_at_idx").on(table.createdAt),
	index("prompts_project_id_id_idx").on(table.projectId, table.id),
]);

export const promptDependencies = sqliteTable("prompt_dependencies", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	parentId: text("parent_id").notNull().references(() => prompts.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	childName: text("child_name").notNull(),
	childLabel: text("child_label"),
	childVersion: integer("child_version"),
},
(table) => [
	index("prompt_dependencies_project_id_child_name").on(table.projectId, table.childName),
	index("prompt_dependencies_project_id_parent_id").on(table.projectId, table.parentId),
]);

export const promptProtectedLabels = sqliteTable("prompt_protected_labels", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	label: text().notNull(),
},
(table) => [
	uniqueIndex("prompt_protected_labels_project_id_label_key").on(table.projectId, table.label),
]);

export const models = sqliteTable("models", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	modelName: text("model_name").notNull(),
	matchPattern: text("match_pattern").notNull(),
	startDate: integer("start_date", { mode: "timestamp_ms" }),
	inputPrice: real("input_price"),
	outputPrice: real("output_price"),
	totalPrice: real("total_price"),
	unit: text(),
	tokenizerId: text("tokenizer_id"),
	tokenizerConfig: text("tokenizer_config"),
},
(table) => [
	uniqueIndex("models_project_id_model_name_start_date_unit_key").on(table.projectId, table.modelName, table.startDate, table.unit),
	index("models_model_name_idx").on(table.modelName),
]);

export const prices = sqliteTable("prices", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	modelId: text("model_id").notNull().references(() => models.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	projectId: text("project_id").references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	pricingTierId: text("pricing_tier_id").notNull().references(() => pricingTiers.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	usageType: text("usage_type").notNull(),
	price: real("price").notNull(),
},
(table) => [
	uniqueIndex("prices_model_id_usage_type_pricing_tier_id_key").on(table.modelId, table.usageType, table.pricingTierId),
	index("prices_pricing_tier_id_idx").on(table.pricingTierId),
]);

export const pricingTiers = sqliteTable("pricing_tiers", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	modelId: text("model_id").notNull().references(() => models.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	name: text().notNull(),
	isDefault: integer("is_default", { mode: "boolean" }).default(false).notNull(),
	priority: integer().notNull(),
	conditions: text().notNull(),
},
(table) => [
	uniqueIndex("pricing_tiers_model_id_name_key").on(table.modelId, table.name),
	uniqueIndex("pricing_tiers_model_id_priority_key").on(table.modelId, table.priority),
]);

export const auditLogs = sqliteTable("audit_logs", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	type: text().default("USER").notNull(),
	apiKeyId: text("api_key_id"),
	userId: text("user_id"),
	orgId: text("org_id").notNull(),
	userOrgRole: text("user_org_role"),
	projectId: text("project_id"),
	userProjectRole: text("user_project_role"),
	resourceType: text("resource_type").notNull(),
	resourceId: text("resource_id").notNull(),
	action: text().notNull(),
	before: text(),
	after: text(),
},
(table) => [
	index("audit_logs_updated_at_idx").on(table.updatedAt),
	index("audit_logs_created_at_idx").on(table.createdAt),
	index("audit_logs_org_id_idx").on(table.orgId),
	index("audit_logs_user_id_idx").on(table.userId),
	index("audit_logs_api_key_id_idx").on(table.apiKeyId),
	index("audit_logs_project_id_idx").on(table.projectId),
]);

export const evalTemplates = sqliteTable("eval_templates", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	name: text().notNull(),
	version: integer().notNull(),
	prompt: text(),
	type: text().default("LLM_AS_JUDGE").notNull(),
	partner: text(),
	model: text(),
	provider: text(),
	modelParams: text("model_params"),
	vars: text().default("[]").notNull(),
	outputSchema: text("output_schema"),
	sourceCode: text("source_code"),
	sourceCodeLanguage: text("source_code_language"),
},
(table) => [
	uniqueIndex("eval_templates_project_id_name_version_key").on(table.projectId, table.name, table.version),
	index("eval_templates_project_id_id_idx").on(table.projectId, table.id),
]);

export const jobConfigurations = sqliteTable("job_configurations", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	jobType: text("job_type").notNull(),
	status: text().default("ACTIVE").notNull(),
	blockedAt: integer("blocked_at", { mode: "timestamp_ms" }),
	blockReason: text("block_reason"),
	blockMessage: text("block_message"),
	evalTemplateId: text("eval_template_id").references(() => evalTemplates.id, { onDelete: "set null", onUpdate: "cascade" } ),
	scoreName: text("score_name").notNull(),
	filter: text().notNull(),
	targetObject: text("target_object").notNull(),
	variableMapping: text("variable_mapping").notNull(),
	sampling: real("sampling").notNull(),
	delay: integer().notNull(),
	timeScope: text("time_scope").default("[]").notNull(),
},
(table) => [
	index("job_configurations_project_id_id_idx").on(table.projectId, table.id),
]);

export const jobExecutions = sqliteTable("job_executions", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	jobConfigurationId: text("job_configuration_id").notNull().references(() => jobConfigurations.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	jobTemplateId: text("job_template_id"),
	status: text().notNull(),
	startTime: integer("start_time", { mode: "timestamp_ms" }),
	endTime: integer("end_time", { mode: "timestamp_ms" }),
	error: text(),
	jobInputTraceId: text("job_input_trace_id"),
	jobInputTraceTimestamp: integer("job_input_trace_timestamp", { mode: "timestamp_ms" }),
	jobInputObservationId: text("job_input_observation_id"),
	jobInputDatasetItemId: text("job_input_dataset_item_id"),
	jobInputDatasetItemValidFrom: integer("job_input_dataset_item_valid_from", { mode: "timestamp_ms" }),
	jobOutputScoreId: text("job_output_score_id"),
	executionTraceId: text("execution_trace_id"),
},
(table) => [
	index("job_executions_job_configuration_id_idx").on(table.jobConfigurationId),
	index("job_executions_project_id_job_output_score_id_idx").on(table.projectId, table.jobOutputScoreId),
	index("job_executions_project_id_job_configuration_id_job_input_trace_id_idx").on(table.projectId, table.jobConfigurationId, table.jobInputTraceId),
]);

export const defaultLlmModels = sqliteTable("default_llm_models", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	llmApiKeyId: text("llm_api_key_id").notNull().references(() => llmApiKeys.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	provider: text().notNull(),
	adapter: text().notNull(),
	model: text().notNull(),
	modelParams: text("model_params"),
},
(table) => [
	uniqueIndex("default_llm_models_project_id_key").on(table.projectId),
]);

export const ssoConfigs = sqliteTable("sso_configs", {
	domain: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	authProvider: text("auth_provider").notNull(),
	authConfig: text("auth_config"),
});

export const verifiedDomains = sqliteTable("verified_domains", {
	id: text().primaryKey().notNull(),
	organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	domain: text().notNull(),
	verificationToken: text("verification_token").notNull(),
	verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
	createdByUserId: text("created_by_user_id"),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
},
(table) => [
	uniqueIndex("verified_domains_organization_id_domain_key").on(table.organizationId, table.domain),
	index("verified_domains_organization_id_idx").on(table.organizationId),
	uniqueIndex("verified_domains_verification_token_key").on(table.verificationToken),
]);

export const posthogIntegrations = sqliteTable("posthog_integrations", {
	projectId: text("project_id").primaryKey().notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	encryptedPosthogApiKey: text("encrypted_posthog_api_key").notNull(),
	posthogHostName: text("posthog_host_name").notNull(),
	lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
	enabled: integer("enabled", { mode: "boolean" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	exportSource: text("export_source").default("TRACES_OBSERVATIONS").notNull(),
});

export const mixpanelIntegrations = sqliteTable("mixpanel_integrations", {
	projectId: text("project_id").primaryKey().notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	encryptedMixpanelProjectToken: text("encrypted_mixpanel_project_token").notNull(),
	mixpanelRegion: text("mixpanel_region").notNull(),
	lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
	enabled: integer("enabled", { mode: "boolean" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	exportSource: text("export_source").default("TRACES_OBSERVATIONS").notNull(),
});

export const blobStorageIntegrations = sqliteTable("blob_storage_integrations", {
	projectId: text("project_id").primaryKey().notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	type: text().notNull(),
	bucketName: text("bucket_name").notNull(),
	prefix: text().notNull(),
	accessKeyId: text("access_key_id"),
	secretAccessKey: text("secret_access_key"),
	region: text().notNull(),
	endpoint: text(),
	forcePathStyle: integer("force_path_style", { mode: "boolean" }).notNull(),
	nextSyncAt: integer("next_sync_at", { mode: "timestamp_ms" }),
	lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
	enabled: integer("enabled", { mode: "boolean" }).notNull(),
	exportFrequency: text("export_frequency").notNull(),
	fileType: text("file_type").default("CSV").notNull(),
	exportMode: text("export_mode").default("FULL_HISTORY").notNull(),
	exportStartDate: integer("export_start_date", { mode: "timestamp_ms" }),
	exportSource: text("export_source").default("TRACES_OBSERVATIONS").notNull(),
	exportFieldGroups: text("export_field_groups").default("[]").notNull(),
	compressed: integer("compressed", { mode: "boolean" }).default(true).notNull(),
	exportTuning: text("export_tuning"),
	runStartedAt: integer("run_started_at", { mode: "timestamp_ms" }),
	lastError: text("last_error"),
	lastErrorAt: integer("last_error_at", { mode: "timestamp_ms" }),
	lastFailureNotificationSentAt: integer("last_failure_notification_sent_at", { mode: "timestamp_ms" }),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
});

export const webCalloutEndpoints = sqliteTable("web_callout_endpoints", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	name: text().default("Default").notNull(),
	url: text().notNull(),
	enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
	toastMessage: text("toast_message").default("Callout sent").notNull(),
	requestHeaders: text("request_headers"),
	requestHeaderKeys: text("request_header_keys").default("[]").notNull(),
},
(table) => [
	index("web_callout_endpoints_project_id_enabled_idx").on(table.projectId, table.enabled),
	index("web_callout_endpoints_project_id_idx").on(table.projectId),
]);

export const batchExports = sqliteTable("batch_exports", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	userId: text("user_id").notNull(),
	finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
	name: text().notNull(),
	status: text().notNull(),
	query: text().notNull(),
	format: text().notNull(),
	url: text(),
	log: text(),
},
(table) => [
	index("batch_exports_status_idx").on(table.status),
	index("batch_exports_project_id_user_id_idx").on(table.projectId, table.userId),
]);

export const batchActions = sqliteTable("batch_actions", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	userId: text("user_id").notNull(),
	actionType: text("action_type").notNull(),
	tableName: text("table_name").notNull(),
	status: text().notNull(),
	finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
	query: text().notNull(),
	config: text(),
	totalCount: integer("total_count"),
	processedCount: integer("processed_count"),
	failedCount: integer("failed_count"),
	log: text(),
},
(table) => [
	index("batch_actions_project_id_action_type_idx").on(table.projectId, table.actionType),
	index("batch_actions_status_idx").on(table.status),
	index("batch_actions_project_id_user_id_idx").on(table.projectId, table.userId),
]);

export const media = sqliteTable("media", {
	id: text().notNull(),
	sha256Hash: text("sha_256_hash").notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	uploadedAt: integer("uploaded_at", { mode: "timestamp_ms" }),
	uploadHttpStatus: integer("upload_http_status"),
	uploadHttpError: text("upload_http_error"),
	bucketPath: text("bucket_path").notNull(),
	bucketName: text("bucket_name").notNull(),
	contentType: text("content_type").notNull(),
	contentLength: integer("content_length").notNull(),
},
(table) => [
	uniqueIndex("media_project_id_sha_256_hash_key").on(table.projectId, table.sha256Hash),
	uniqueIndex("media_project_id_id_key").on(table.projectId, table.id),
	index("media_project_id_created_at_idx").on(table.projectId, table.createdAt),
]);

export const traceMedia = sqliteTable("trace_media", {
	id: text().primaryKey().notNull(),
	projectId: text("project_id").notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	mediaId: text("media_id").notNull(),
	traceId: text("trace_id").notNull(),
	field: text().notNull(),
},
(table) => [
	uniqueIndex("trace_media_project_id_trace_id_media_id_field_key").on(table.projectId, table.traceId, table.mediaId, table.field),
	index("trace_media_project_id_media_id_idx").on(table.projectId, table.mediaId),
]);

export const observationMedia = sqliteTable("observation_media", {
	id: text().primaryKey().notNull(),
	projectId: text("project_id").notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	mediaId: text("media_id").notNull(),
	traceId: text("trace_id").notNull(),
	observationId: text("observation_id").notNull(),
	field: text().notNull(),
},
(table) => [
	uniqueIndex("observation_media_project_id_trace_id_observation_id_media_id_field_key").on(table.projectId, table.traceId, table.observationId, table.mediaId, table.field),
	index("observation_media_project_id_media_id_idx").on(table.projectId, table.mediaId),
]);

export const datasetItemMedia = sqliteTable("dataset_item_media", {
	id: text().primaryKey().notNull(),
	projectId: text("project_id").notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	mediaId: text("media_id").notNull(),
	datasetId: text("dataset_id").notNull(),
	datasetItemId: text("dataset_item_id").notNull(),
	datasetItemValidFrom: integer("dataset_item_valid_from", { mode: "timestamp_ms" }),
	field: text().notNull(),
	jsonPath: text("json_path"),
	referenceString: text("reference_string"),
},
(table) => [
	uniqueIndex("dataset_item_media_item_version_field_path_key").on(table.projectId, table.datasetItemId, table.datasetItemValidFrom, table.field, table.jsonPath),
	index("dataset_item_media_project_id_dataset_id_idx").on(table.projectId, table.datasetId),
	index("dataset_item_media_project_id_media_id_idx").on(table.projectId, table.mediaId),
]);

export const billingMeterBackups = sqliteTable("billing_meter_backups", {
	stripeCustomerId: text("stripe_customer_id").notNull(),
	meterId: text("meter_id").notNull(),
	startTime: integer("start_time", { mode: "timestamp_ms" }).notNull(),
	endTime: integer("end_time", { mode: "timestamp_ms" }).notNull(),
	aggregatedValue: integer("aggregated_value").notNull(),
	eventName: text("event_name").notNull(),
	orgId: text("org_id").notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
},
(table) => [
	uniqueIndex("billing_meter_backups_stripe_customer_id_meter_id_start_time_end_time_key").on(table.stripeCustomerId, table.meterId, table.startTime, table.endTime),
	index("billing_meter_backups_stripe_customer_id_meter_id_start_time_end_time_idx").on(table.stripeCustomerId, table.meterId, table.startTime, table.endTime),
]);

export const llmSchemas = sqliteTable("llm_schemas", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	name: text().notNull(),
	description: text().notNull(),
	schema: text().notNull(),
},
(table) => [
	uniqueIndex("llm_schemas_project_id_name_key").on(table.projectId, table.name),
]);

export const llmTools = sqliteTable("llm_tools", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	name: text().notNull(),
	description: text().notNull(),
	parameters: text().notNull(),
},
(table) => [
	uniqueIndex("llm_tools_project_id_name_key").on(table.projectId, table.name),
]);

export const dashboards = sqliteTable("dashboards", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	createdBy: text("created_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" } ),
	updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" } ),
	projectId: text("project_id").references((): AnySQLiteColumn => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	name: text().notNull(),
	description: text().notNull(),
	definition: text().notNull(),
	filters: text().default("[]").notNull(),
});

export const dashboardWidgets = sqliteTable("dashboard_widgets", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	createdBy: text("created_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" } ),
	updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" } ),
	projectId: text("project_id").references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	name: text().notNull(),
	description: text().notNull(),
	view: text().notNull(),
	dimensions: text().notNull(),
	metrics: text().notNull(),
	filters: text().notNull(),
	chartType: text("chart_type").notNull(),
	chartConfig: text("chart_config").notNull(),
	minVersion: integer("min_version").default(1).notNull(),
});

export const tableViewPresets = sqliteTable("table_view_presets", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	name: text().notNull(),
	tableName: text("table_name").notNull(),
	createdBy: text("created_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" } ),
	updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" } ),
	filters: text().notNull(),
	columnOrder: text("column_order").notNull(),
	columnVisibility: text("column_visibility").notNull(),
	searchQuery: text("search_query"),
	orderBy: text("order_by"),
},
(table) => [
	uniqueIndex("table_view_presets_project_id_table_name_name_key").on(table.projectId, table.tableName, table.name),
]);

export const defaultViews = sqliteTable("default_views", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	userId: text("user_id").references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	viewName: text("view_name").notNull(),
	viewId: text("view_id").notNull(),
},
(table) => [
	index("default_views_project_id_view_name_idx").on(table.projectId, table.viewName),
]);

export const actions = sqliteTable("actions", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	type: text().notNull(),
	config: text().notNull(),
},
(table) => [
	index("actions_project_id_idx").on(table.projectId),
]);

export const triggers = sqliteTable("triggers", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	eventSource: text().notNull(),
	eventActions: text().notNull(),
	filter: text(),
	status: text().default("ACTIVE").notNull(),
},
(table) => [
	index("triggers_project_id_idx").on(table.projectId),
]);

export const automations = sqliteTable("automations", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	triggerId: text("trigger_id").notNull().references(() => triggers.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	actionId: text("action_id").notNull().references(() => actions.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
},
(table) => [
	index("automations_project_id_name_idx").on(table.projectId, table.name),
	index("automations_project_id_action_id_trigger_id_idx").on(table.projectId, table.actionId, table.triggerId),
]);

export const automationExecutions = sqliteTable("automation_executions", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	sourceId: text("source_id").notNull(),
	automationId: text("automation_id").notNull().references(() => automations.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	triggerId: text("trigger_id").notNull().references(() => triggers.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	actionId: text("action_id").notNull().references(() => actions.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	status: text().default("PENDING").notNull(),
	input: text().notNull(),
	output: text(),
	startedAt: integer("started_at", { mode: "timestamp_ms" }),
	finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
	error: text(),
},
(table) => [
	index("automation_executions_project_id_idx").on(table.projectId),
	index("automation_executions_action_id_idx").on(table.actionId),
	index("automation_executions_trigger_id_idx").on(table.triggerId),
]);

export const monitors = sqliteTable("monitors", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
	createdBy: text("created_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" } ),
	updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" } ),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	view: text().notNull(),
	filters: text().notNull(),
	metric: text().notNull(),
	windowMs: integer("window_ms").notNull(),
	cadenceMs: integer("cadence_ms").notNull(),
	thresholdOperator: text("threshold_operator").notNull(),
	alertThreshold: real("alert_threshold").notNull(),
	warningThreshold: real("warning_threshold"),
	severity: text().default("UNKNOWN").notNull(),
	severityChangedAt: integer("severity_changed_at", { mode: "timestamp_ms" }),
	noData: text("no_data").notNull(),
	renotify: text().notNull(),
	status: text().default("ACTIVE").notNull(),
	schedulerBatchId: integer("scheduler_batch_id").notNull(),
	nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }),
	lastPublishedAt: integer("last_published_at", { mode: "timestamp_ms" }),
	lastClaimedAt: integer("last_claimed_at", { mode: "timestamp_ms" }),
	lastCompletedAt: integer("last_completed_at", { mode: "timestamp_ms" }),
	name: text().notNull(),
	tags: text().default("[]").notNull(),
	triggerIds: text("trigger_ids").default("[]").notNull(),
	alertedAt: integer("alerted_at", { mode: "timestamp_ms" }),
},
(table) => [
	index("monitors_scheduler_tick_idx").on(table.nextRunAt, table.schedulerBatchId),
	index("monitors_scheduler_batch_id_idx").on(table.schedulerBatchId),
	index("monitors_project_id_idx").on(table.projectId),
]);

export const slackIntegrations = sqliteTable("slack_integrations", {
	id: text().primaryKey().notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	teamId: text("team_id").notNull(),
	teamName: text("team_name").notNull(),
	botToken: text("bot_token").notNull(),
	botUserId: text("bot_user_id").notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
},
(table) => [
	index("slack_integrations_team_id_idx").on(table.teamId),
	uniqueIndex("slack_integrations_project_id_key").on(table.projectId),
]);

export const pendingDeletions = sqliteTable("pending_deletions", {
	id: text().primaryKey().notNull(),
	projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	object: text().notNull(),
	objectId: text("object_id").notNull(),
	isDeleted: integer("is_deleted", { mode: "boolean" }).default(false).notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
},
(table) => [
	index("pending_deletions_object_id_object_idx").on(table.objectId, table.object),
	index("pending_deletions_project_id_object_is_deleted_object_id_id_idx").on(table.projectId, table.object, table.isDeleted, table.objectId, table.id),
]);

export const surveys = sqliteTable("surveys", {
	id: text().primaryKey().notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	surveyName: text("survey_name").notNull(),
	response: text().notNull(),
	userId: text("user_id").references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	userEmail: text("user_email"),
	orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade", onUpdate: "cascade" } ),
});

export const cloudSpendAlerts = sqliteTable("cloud_spend_alerts", {
	id: text().primaryKey().notNull(),
	orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	title: text().notNull(),
	threshold: real("threshold").notNull(),
	triggeredAt: integer("triggered_at", { mode: "timestamp_ms" }),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()).notNull(),
},
(table) => [
	index("cloud_spend_alerts_org_id_idx").on(table.orgId),
]);

