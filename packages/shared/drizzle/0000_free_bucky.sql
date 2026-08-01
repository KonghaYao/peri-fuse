CREATE TABLE `Account` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`provider` text NOT NULL,
	`providerAccountId` text NOT NULL,
	`refresh_token` text,
	`access_token` text,
	`expires_at` integer,
	`expires_in` integer,
	`ext_expires_in` integer,
	`token_type` text,
	`scope` text,
	`id_token` text,
	`session_state` text,
	`refresh_token_expires_in` integer,
	`created_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Account_provider_providerAccountId_key` ON `Account` (`provider`,`providerAccountId`);--> statement-breakpoint
CREATE INDEX `Account_user_id_idx` ON `Account` (`user_id`);--> statement-breakpoint
CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `actions_project_id_idx` ON `actions` (`project_id`);--> statement-breakpoint
CREATE TABLE `annotation_queue_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`queue_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`queue_id`) REFERENCES `annotation_queues`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `annotation_queue_assignments_project_id_queue_id_user_id_key` ON `annotation_queue_assignments` (`project_id`,`queue_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `annotation_queue_items` (
	`id` text PRIMARY KEY NOT NULL,
	`queue_id` text NOT NULL,
	`object_id` text NOT NULL,
	`object_type` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`locked_at` integer,
	`locked_by_user_id` text,
	`annotator_user_id` text,
	`completed_at` integer,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`queue_id`) REFERENCES `annotation_queues`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`locked_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`annotator_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `annotation_queue_items_created_at_idx` ON `annotation_queue_items` (`created_at`);--> statement-breakpoint
CREATE INDEX `annotation_queue_items_annotator_user_id_idx` ON `annotation_queue_items` (`annotator_user_id`);--> statement-breakpoint
CREATE INDEX `annotation_queue_items_object_id_object_type_project_id_queue_id_idx` ON `annotation_queue_items` (`object_id`,`object_type`,`project_id`,`queue_id`);--> statement-breakpoint
CREATE INDEX `annotation_queue_items_project_id_queue_id_status_idx` ON `annotation_queue_items` (`project_id`,`queue_id`,`status`);--> statement-breakpoint
CREATE INDEX `annotation_queue_items_id_project_id_idx` ON `annotation_queue_items` (`id`,`project_id`);--> statement-breakpoint
CREATE TABLE `annotation_queues` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`score_config_ids` text DEFAULT '[]' NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `annotation_queues_project_id_name_key` ON `annotation_queues` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `annotation_queues_project_id_created_at_idx` ON `annotation_queues` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `annotation_queues_id_project_id_idx` ON `annotation_queues` (`id`,`project_id`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`note` text,
	`public_key` text NOT NULL,
	`hashed_secret_key` text NOT NULL,
	`fast_hashed_secret_key` text,
	`display_secret_key` text NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`is_in_app_agent_key` integer DEFAULT false NOT NULL,
	`project_id` text,
	`organization_id` text,
	`scope` text DEFAULT 'PROJECT' NOT NULL,
	`created_by_user_id` text,
	`created_by_api_key_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`created_by_api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `api_keys_fast_hashed_secret_key_idx` ON `api_keys` (`fast_hashed_secret_key`);--> statement-breakpoint
CREATE INDEX `api_keys_hashed_secret_key_idx` ON `api_keys` (`hashed_secret_key`);--> statement-breakpoint
CREATE INDEX `api_keys_public_key_idx` ON `api_keys` (`public_key`);--> statement-breakpoint
CREATE INDEX `api_keys_created_by_api_key_id_idx` ON `api_keys` (`created_by_api_key_id`);--> statement-breakpoint
CREATE INDEX `api_keys_project_id_idx` ON `api_keys` (`project_id`);--> statement-breakpoint
CREATE INDEX `api_keys_organization_id_idx` ON `api_keys` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_fast_hashed_secret_key_key` ON `api_keys` (`fast_hashed_secret_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hashed_secret_key_key` ON `api_keys` (`hashed_secret_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_public_key_key` ON `api_keys` (`public_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_id_key` ON `api_keys` (`id`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`type` text DEFAULT 'USER' NOT NULL,
	`api_key_id` text,
	`user_id` text,
	`org_id` text NOT NULL,
	`user_org_role` text,
	`project_id` text,
	`user_project_role` text,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`action` text NOT NULL,
	`before` text,
	`after` text
);
--> statement-breakpoint
CREATE INDEX `audit_logs_updated_at_idx` ON `audit_logs` (`updated_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_created_at_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_org_id_idx` ON `audit_logs` (`org_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_user_id_idx` ON `audit_logs` (`user_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_api_key_id_idx` ON `audit_logs` (`api_key_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_project_id_idx` ON `audit_logs` (`project_id`);--> statement-breakpoint
CREATE TABLE `automation_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`source_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`trigger_id` text NOT NULL,
	`action_id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`input` text NOT NULL,
	`output` text,
	`started_at` integer,
	`finished_at` integer,
	`error` text,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`trigger_id`) REFERENCES `triggers`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`action_id`) REFERENCES `actions`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `automation_executions_project_id_idx` ON `automation_executions` (`project_id`);--> statement-breakpoint
CREATE INDEX `automation_executions_action_id_idx` ON `automation_executions` (`action_id`);--> statement-breakpoint
CREATE INDEX `automation_executions_trigger_id_idx` ON `automation_executions` (`trigger_id`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`trigger_id` text NOT NULL,
	`action_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`project_id` text NOT NULL,
	FOREIGN KEY (`trigger_id`) REFERENCES `triggers`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`action_id`) REFERENCES `actions`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `automations_project_id_name_idx` ON `automations` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `automations_project_id_action_id_trigger_id_idx` ON `automations` (`project_id`,`action_id`,`trigger_id`);--> statement-breakpoint
CREATE TABLE `background_migrations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`script` text NOT NULL,
	`args` text NOT NULL,
	`state` text DEFAULT '{}' NOT NULL,
	`finished_at` integer,
	`failed_at` integer,
	`failed_reason` text,
	`worker_id` text,
	`locked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `background_migrations_name_key` ON `background_migrations` (`name`);--> statement-breakpoint
CREATE TABLE `batch_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`action_type` text NOT NULL,
	`table_name` text NOT NULL,
	`status` text NOT NULL,
	`finished_at` integer,
	`query` text NOT NULL,
	`config` text,
	`total_count` integer,
	`processed_count` integer,
	`failed_count` integer,
	`log` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `batch_actions_project_id_action_type_idx` ON `batch_actions` (`project_id`,`action_type`);--> statement-breakpoint
CREATE INDEX `batch_actions_status_idx` ON `batch_actions` (`status`);--> statement-breakpoint
CREATE INDEX `batch_actions_project_id_user_id_idx` ON `batch_actions` (`project_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `batch_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`finished_at` integer,
	`expires_at` integer,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`query` text NOT NULL,
	`format` text NOT NULL,
	`url` text,
	`log` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `batch_exports_status_idx` ON `batch_exports` (`status`);--> statement-breakpoint
CREATE INDEX `batch_exports_project_id_user_id_idx` ON `batch_exports` (`project_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `billing_meter_backups` (
	`stripe_customer_id` text NOT NULL,
	`meter_id` text NOT NULL,
	`start_time` integer NOT NULL,
	`end_time` integer NOT NULL,
	`aggregated_value` integer NOT NULL,
	`event_name` text NOT NULL,
	`org_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_meter_backups_stripe_customer_id_meter_id_start_time_end_time_key` ON `billing_meter_backups` (`stripe_customer_id`,`meter_id`,`start_time`,`end_time`);--> statement-breakpoint
CREATE INDEX `billing_meter_backups_stripe_customer_id_meter_id_start_time_end_time_idx` ON `billing_meter_backups` (`stripe_customer_id`,`meter_id`,`start_time`,`end_time`);--> statement-breakpoint
CREATE TABLE `blob_storage_integrations` (
	`project_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`bucket_name` text NOT NULL,
	`prefix` text NOT NULL,
	`access_key_id` text,
	`secret_access_key` text,
	`region` text NOT NULL,
	`endpoint` text,
	`force_path_style` integer NOT NULL,
	`next_sync_at` integer,
	`last_sync_at` integer,
	`enabled` integer NOT NULL,
	`export_frequency` text NOT NULL,
	`file_type` text DEFAULT 'CSV' NOT NULL,
	`export_mode` text DEFAULT 'FULL_HISTORY' NOT NULL,
	`export_start_date` integer,
	`export_source` text DEFAULT 'TRACES_OBSERVATIONS' NOT NULL,
	`export_field_groups` text DEFAULT '[]' NOT NULL,
	`compressed` integer DEFAULT true NOT NULL,
	`export_tuning` text,
	`run_started_at` integer,
	`last_error` text,
	`last_error_at` integer,
	`last_failure_notification_sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `cloud_spend_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`title` text NOT NULL,
	`threshold` real NOT NULL,
	`triggered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cloud_spend_alerts_org_id_idx` ON `cloud_spend_alerts` (`org_id`);--> statement-breakpoint
CREATE TABLE `comment_reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`comment_id` text NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comment_reactions_comment_id_user_id_emoji_key` ON `comment_reactions` (`comment_id`,`user_id`,`emoji`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`object_type` text NOT NULL,
	`object_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`content` text NOT NULL,
	`author_user_id` text,
	`data_field` text,
	`path` text DEFAULT '[]' NOT NULL,
	`range_start` text DEFAULT '[]' NOT NULL,
	`range_end` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comments_project_id_object_type_object_id_idx` ON `comments` (`project_id`,`object_type`,`object_id`);--> statement-breakpoint
CREATE TABLE `cron_jobs` (
	`name` text PRIMARY KEY NOT NULL,
	`last_run` integer,
	`job_started_at` integer,
	`state` text
);
--> statement-breakpoint
CREATE TABLE `dashboard_widgets` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`updated_by` text,
	`project_id` text,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`view` text NOT NULL,
	`dimensions` text NOT NULL,
	`metrics` text NOT NULL,
	`filters` text NOT NULL,
	`chart_type` text NOT NULL,
	`chart_config` text NOT NULL,
	`min_version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `dashboards` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`updated_by` text,
	`project_id` text,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`definition` text NOT NULL,
	`filters` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `dataset_item_media` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`media_id` text NOT NULL,
	`dataset_id` text NOT NULL,
	`dataset_item_id` text NOT NULL,
	`dataset_item_valid_from` integer,
	`field` text NOT NULL,
	`json_path` text,
	`reference_string` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dataset_item_media_item_version_field_path_key` ON `dataset_item_media` (`project_id`,`dataset_item_id`,`dataset_item_valid_from`,`field`,`json_path`);--> statement-breakpoint
CREATE INDEX `dataset_item_media_project_id_dataset_id_idx` ON `dataset_item_media` (`project_id`,`dataset_id`);--> statement-breakpoint
CREATE INDEX `dataset_item_media_project_id_media_id_idx` ON `dataset_item_media` (`project_id`,`media_id`);--> statement-breakpoint
CREATE TABLE `dataset_items` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'ACTIVE',
	`input` text,
	`expected_output` text,
	`metadata` text,
	`source_trace_id` text,
	`source_observation_id` text,
	`dataset_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`valid_from` integer NOT NULL,
	`valid_to` integer,
	`is_deleted` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`id`, `project_id`, `valid_from`),
	FOREIGN KEY (`dataset_id`,`project_id`) REFERENCES `datasets`(`id`,`project_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dataset_items_updated_at_idx` ON `dataset_items` (`updated_at`);--> statement-breakpoint
CREATE INDEX `dataset_items_created_at_idx` ON `dataset_items` (`created_at`);--> statement-breakpoint
CREATE INDEX `dataset_items_dataset_id_idx` ON `dataset_items` (`dataset_id`);--> statement-breakpoint
CREATE INDEX `dataset_items_source_observation_id_idx` ON `dataset_items` (`source_observation_id`);--> statement-breakpoint
CREATE INDEX `dataset_items_source_trace_id_idx` ON `dataset_items` (`source_trace_id`);--> statement-breakpoint
CREATE INDEX `dataset_items_project_id_id_valid_from_idx` ON `dataset_items` (`project_id`,`id`,`valid_from`);--> statement-breakpoint
CREATE INDEX `dataset_items_project_id_valid_to_idx` ON `dataset_items` (`project_id`,`valid_to`);--> statement-breakpoint
CREATE TABLE `dataset_runs` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`metadata` text,
	`dataset_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`id`, `project_id`),
	FOREIGN KEY (`dataset_id`,`project_id`) REFERENCES `datasets`(`id`,`project_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dataset_runs_dataset_id_project_id_name_key` ON `dataset_runs` (`dataset_id`,`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `dataset_runs_updated_at_idx` ON `dataset_runs` (`updated_at`);--> statement-breakpoint
CREATE INDEX `dataset_runs_created_at_idx` ON `dataset_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `dataset_runs_dataset_id_idx` ON `dataset_runs` (`dataset_id`);--> statement-breakpoint
CREATE TABLE `datasets` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`metadata` text,
	`remote_experiment_url` text,
	`remote_experiment_payload` text,
	`remote_experiment_enabled` integer DEFAULT true NOT NULL,
	`input_schema` text,
	`expected_output_schema` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`id`, `project_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `datasets_project_id_name_key` ON `datasets` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `datasets_updated_at_idx` ON `datasets` (`updated_at`);--> statement-breakpoint
CREATE INDEX `datasets_created_at_idx` ON `datasets` (`created_at`);--> statement-breakpoint
CREATE TABLE `default_llm_models` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`llm_api_key_id` text NOT NULL,
	`provider` text NOT NULL,
	`adapter` text NOT NULL,
	`model` text NOT NULL,
	`model_params` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`llm_api_key_id`) REFERENCES `llm_api_keys`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `default_llm_models_project_id_key` ON `default_llm_models` (`project_id`);--> statement-breakpoint
CREATE TABLE `default_views` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text,
	`view_name` text NOT NULL,
	`view_id` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `default_views_project_id_view_name_idx` ON `default_views` (`project_id`,`view_name`);--> statement-breakpoint
CREATE TABLE `eval_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`prompt` text,
	`type` text DEFAULT 'LLM_AS_JUDGE' NOT NULL,
	`partner` text,
	`model` text,
	`provider` text,
	`model_params` text,
	`vars` text DEFAULT '[]' NOT NULL,
	`output_schema` text,
	`source_code` text,
	`source_code_language` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `eval_templates_project_id_name_version_key` ON `eval_templates` (`project_id`,`name`,`version`);--> statement-breakpoint
CREATE INDEX `eval_templates_project_id_id_idx` ON `eval_templates` (`project_id`,`id`);--> statement-breakpoint
CREATE TABLE `in_app_agent_conversations` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_by_user_id` text,
	`title` text,
	`renamed_by_user_at` integer,
	`visibility_scope` text DEFAULT 'PERSONAL' NOT NULL,
	`provider_session_id` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`id`, `project_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `in_app_agent_conversations_project_user_list_idx` ON `in_app_agent_conversations` (`project_id`,`created_by_user_id`,`deleted_at`,`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `in_app_agent_events` (
	`project_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`type` text NOT NULL,
	`event` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `conversation_id`, `sequence_number`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`run_id`,`project_id`) REFERENCES `in_app_agent_runs`(`id`,`project_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`conversation_id`,`project_id`) REFERENCES `in_app_agent_conversations`(`id`,`project_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `in_app_agent_events_project_run_idx` ON `in_app_agent_events` (`project_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `in_app_agent_pending_tool_approvals` (
	`project_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`approval_fingerprint` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `conversation_id`, `tool_call_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`conversation_id`,`project_id`) REFERENCES `in_app_agent_conversations`(`id`,`project_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `in_app_agent_pending_tool_approvals_expires_at_idx` ON `in_app_agent_pending_tool_approvals` (`expires_at`);--> statement-breakpoint
CREATE TABLE `in_app_agent_runs` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`triggered_by_user_id` text,
	`model` text,
	`mcp_api_key_id` text,
	`error_code` text,
	`error_message` text,
	`finished_at` integer,
	`status` text,
	`request` text,
	`claimed_at` integer,
	`heartbeat_at` integer,
	`cancel_requested_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`id`, `project_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`triggered_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`conversation_id`,`project_id`) REFERENCES `in_app_agent_conversations`(`id`,`project_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `in_app_agent_runs_project_conversation_created_idx` ON `in_app_agent_runs` (`project_id`,`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `job_configurations` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`job_type` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`blocked_at` integer,
	`block_reason` text,
	`block_message` text,
	`eval_template_id` text,
	`score_name` text NOT NULL,
	`filter` text NOT NULL,
	`target_object` text NOT NULL,
	`variable_mapping` text NOT NULL,
	`sampling` real NOT NULL,
	`delay` integer NOT NULL,
	`time_scope` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`eval_template_id`) REFERENCES `eval_templates`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `job_configurations_project_id_id_idx` ON `job_configurations` (`project_id`,`id`);--> statement-breakpoint
CREATE TABLE `job_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`job_configuration_id` text NOT NULL,
	`job_template_id` text,
	`status` text NOT NULL,
	`start_time` integer,
	`end_time` integer,
	`error` text,
	`job_input_trace_id` text,
	`job_input_trace_timestamp` integer,
	`job_input_observation_id` text,
	`job_input_dataset_item_id` text,
	`job_input_dataset_item_valid_from` integer,
	`job_output_score_id` text,
	`execution_trace_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`job_configuration_id`) REFERENCES `job_configurations`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_executions_job_configuration_id_idx` ON `job_executions` (`job_configuration_id`);--> statement-breakpoint
CREATE INDEX `job_executions_project_id_job_output_score_id_idx` ON `job_executions` (`project_id`,`job_output_score_id`);--> statement-breakpoint
CREATE INDEX `job_executions_project_id_job_configuration_id_job_input_trace_id_idx` ON `job_executions` (`project_id`,`job_configuration_id`,`job_input_trace_id`);--> statement-breakpoint
CREATE TABLE `llm_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`provider` text NOT NULL,
	`adapter` text NOT NULL,
	`display_secret_key` text NOT NULL,
	`secret_key` text NOT NULL,
	`base_url` text,
	`custom_models` text DEFAULT '[]' NOT NULL,
	`with_default_models` integer DEFAULT true NOT NULL,
	`extra_headers` text,
	`extra_header_keys` text DEFAULT '[]' NOT NULL,
	`config` text,
	`project_id` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `llm_api_keys_project_id_provider_key` ON `llm_api_keys` (`project_id`,`provider`);--> statement-breakpoint
CREATE UNIQUE INDEX `llm_api_keys_id_key` ON `llm_api_keys` (`id`);--> statement-breakpoint
CREATE TABLE `llm_schemas` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`schema` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `llm_schemas_project_id_name_key` ON `llm_schemas` (`project_id`,`name`);--> statement-breakpoint
CREATE TABLE `llm_tools` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`parameters` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `llm_tools_project_id_name_key` ON `llm_tools` (`project_id`,`name`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` text NOT NULL,
	`sha_256_hash` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`uploaded_at` integer,
	`upload_http_status` integer,
	`upload_http_error` text,
	`bucket_path` text NOT NULL,
	`bucket_name` text NOT NULL,
	`content_type` text NOT NULL,
	`content_length` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_project_id_sha_256_hash_key` ON `media` (`project_id`,`sha_256_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_project_id_id_key` ON `media` (`project_id`,`id`);--> statement-breakpoint
CREATE INDEX `media_project_id_created_at_idx` ON `media` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `membership_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`org_id` text NOT NULL,
	`org_role` text NOT NULL,
	`project_id` text,
	`project_role` text,
	`invited_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `membership_invitations_email_org_id_key` ON `membership_invitations` (`email`,`org_id`);--> statement-breakpoint
CREATE INDEX `membership_invitations_email_idx` ON `membership_invitations` (`email`);--> statement-breakpoint
CREATE INDEX `membership_invitations_org_id_idx` ON `membership_invitations` (`org_id`);--> statement-breakpoint
CREATE INDEX `membership_invitations_project_id_idx` ON `membership_invitations` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `membership_invitations_id_key` ON `membership_invitations` (`id`);--> statement-breakpoint
CREATE TABLE `mixpanel_integrations` (
	`project_id` text PRIMARY KEY NOT NULL,
	`encrypted_mixpanel_project_token` text NOT NULL,
	`mixpanel_region` text NOT NULL,
	`last_sync_at` integer,
	`enabled` integer NOT NULL,
	`created_at` integer NOT NULL,
	`export_source` text DEFAULT 'TRACES_OBSERVATIONS' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text,
	`model_name` text NOT NULL,
	`match_pattern` text NOT NULL,
	`start_date` integer,
	`input_price` real,
	`output_price` real,
	`total_price` real,
	`unit` text,
	`tokenizer_id` text,
	`tokenizer_config` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_project_id_model_name_start_date_unit_key` ON `models` (`project_id`,`model_name`,`start_date`,`unit`);--> statement-breakpoint
CREATE INDEX `models_model_name_idx` ON `models` (`model_name`);--> statement-breakpoint
CREATE TABLE `monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`updated_by` text,
	`project_id` text NOT NULL,
	`view` text NOT NULL,
	`filters` text NOT NULL,
	`metric` text NOT NULL,
	`window_ms` integer NOT NULL,
	`cadence_ms` integer NOT NULL,
	`threshold_operator` text NOT NULL,
	`alert_threshold` real NOT NULL,
	`warning_threshold` real,
	`severity` text DEFAULT 'UNKNOWN' NOT NULL,
	`severity_changed_at` integer,
	`no_data` text NOT NULL,
	`renotify` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`scheduler_batch_id` integer NOT NULL,
	`next_run_at` integer,
	`last_published_at` integer,
	`last_claimed_at` integer,
	`last_completed_at` integer,
	`name` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`trigger_ids` text DEFAULT '[]' NOT NULL,
	`alerted_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `monitors_scheduler_tick_idx` ON `monitors` (`next_run_at`,`scheduler_batch_id`);--> statement-breakpoint
CREATE INDEX `monitors_scheduler_batch_id_idx` ON `monitors` (`scheduler_batch_id`);--> statement-breakpoint
CREATE INDEX `monitors_project_id_idx` ON `monitors` (`project_id`);--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`channel` text NOT NULL,
	`type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_preferences_user_id_project_id_channel_type_key` ON `notification_preferences` (`user_id`,`project_id`,`channel`,`type`);--> statement-breakpoint
CREATE TABLE `observation_media` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`media_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`observation_id` text NOT NULL,
	`field` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `observation_media_project_id_trace_id_observation_id_media_id_field_key` ON `observation_media` (`project_id`,`trace_id`,`observation_id`,`media_id`,`field`);--> statement-breakpoint
CREATE INDEX `observation_media_project_id_media_id_idx` ON `observation_media` (`project_id`,`media_id`);--> statement-breakpoint
CREATE TABLE `organization_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_memberships_org_id_user_id_key` ON `organization_memberships` (`org_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `organization_memberships_user_id_idx` ON `organization_memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`cloud_config` text,
	`metadata` text,
	`cloud_billing_cycle_anchor` integer,
	`cloud_billing_cycle_updated_at` integer,
	`cloud_current_cycle_usage` integer,
	`cloud_free_tier_usage_threshold_state` text,
	`ai_features_enabled` integer DEFAULT false NOT NULL,
	`ai_telemetry_enabled` integer DEFAULT true NOT NULL,
	`sfdc_org_id` text
);
--> statement-breakpoint
CREATE TABLE `pending_deletions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`object` text NOT NULL,
	`object_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pending_deletions_object_id_object_idx` ON `pending_deletions` (`object_id`,`object`);--> statement-breakpoint
CREATE INDEX `pending_deletions_project_id_object_is_deleted_object_id_id_idx` ON `pending_deletions` (`project_id`,`object`,`is_deleted`,`object_id`,`id`);--> statement-breakpoint
CREATE TABLE `posthog_integrations` (
	`project_id` text PRIMARY KEY NOT NULL,
	`encrypted_posthog_api_key` text NOT NULL,
	`posthog_host_name` text NOT NULL,
	`last_sync_at` integer,
	`enabled` integer NOT NULL,
	`created_at` integer NOT NULL,
	`export_source` text DEFAULT 'TRACES_OBSERVATIONS' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `prices` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`model_id` text NOT NULL,
	`project_id` text,
	`pricing_tier_id` text NOT NULL,
	`usage_type` text NOT NULL,
	`price` real NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`pricing_tier_id`) REFERENCES `pricing_tiers`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prices_model_id_usage_type_pricing_tier_id_key` ON `prices` (`model_id`,`usage_type`,`pricing_tier_id`);--> statement-breakpoint
CREATE INDEX `prices_pricing_tier_id_idx` ON `prices` (`pricing_tier_id`);--> statement-breakpoint
CREATE TABLE `pricing_tiers` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`model_id` text NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`priority` integer NOT NULL,
	`conditions` text NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pricing_tiers_model_id_name_key` ON `pricing_tiers` (`model_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `pricing_tiers_model_id_priority_key` ON `pricing_tiers` (`model_id`,`priority`);--> statement-breakpoint
CREATE TABLE `project_memberships` (
	`org_membership_id` text NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `user_id`),
	FOREIGN KEY (`org_membership_id`) REFERENCES `organization_memberships`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_memberships_org_membership_id_idx` ON `project_memberships` (`org_membership_id`);--> statement-breakpoint
CREATE INDEX `project_memberships_project_id_idx` ON `project_memberships` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_memberships_user_id_idx` ON `project_memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`name` text NOT NULL,
	`retention_days` integer,
	`has_traces` integer DEFAULT false NOT NULL,
	`metadata` text,
	`home_dashboard_id` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`home_dashboard_id`) REFERENCES `dashboards`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `projects_org_id_idx` ON `projects` (`org_id`);--> statement-breakpoint
CREATE TABLE `prompt_dependencies` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`parent_id` text NOT NULL,
	`child_name` text NOT NULL,
	`child_label` text,
	`child_version` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `prompts`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `prompt_dependencies_project_id_child_name` ON `prompt_dependencies` (`project_id`,`child_name`);--> statement-breakpoint
CREATE INDEX `prompt_dependencies_project_id_parent_id` ON `prompt_dependencies` (`project_id`,`parent_id`);--> statement-breakpoint
CREATE TABLE `prompt_protected_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`label` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_protected_labels_project_id_label_key` ON `prompt_protected_labels` (`project_id`,`label`);--> statement-breakpoint
CREATE TABLE `prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`created_by` text NOT NULL,
	`prompt` text NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`type` text DEFAULT 'text' NOT NULL,
	`is_active` integer,
	`config` text DEFAULT '{}' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`commit_message` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_project_id_name_version_key` ON `prompts` (`project_id`,`name`,`version`);--> statement-breakpoint
CREATE INDEX `prompts_tags_idx` ON `prompts` (`tags`);--> statement-breakpoint
CREATE INDEX `prompts_updated_at_idx` ON `prompts` (`updated_at`);--> statement-breakpoint
CREATE INDEX `prompts_created_at_idx` ON `prompts` (`created_at`);--> statement-breakpoint
CREATE INDEX `prompts_project_id_id_idx` ON `prompts` (`project_id`,`id`);--> statement-breakpoint
CREATE TABLE `score_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`data_type` text NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	`min_value` real,
	`max_value` real,
	`categories` text,
	`description` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `score_configs_id_project_id_key` ON `score_configs` (`id`,`project_id`);--> statement-breakpoint
CREATE INDEX `score_configs_updated_at_idx` ON `score_configs` (`updated_at`);--> statement-breakpoint
CREATE INDEX `score_configs_created_at_idx` ON `score_configs` (`created_at`);--> statement-breakpoint
CREATE INDEX `score_configs_categories_idx` ON `score_configs` (`categories`);--> statement-breakpoint
CREATE INDEX `score_configs_project_id_idx` ON `score_configs` (`project_id`);--> statement-breakpoint
CREATE INDEX `score_configs_is_archived_idx` ON `score_configs` (`is_archived`);--> statement-breakpoint
CREATE INDEX `score_configs_data_type_idx` ON `score_configs` (`data_type`);--> statement-breakpoint
CREATE TABLE `Session` (
	`id` text PRIMARY KEY NOT NULL,
	`session_token` text NOT NULL,
	`user_id` text NOT NULL,
	`expires` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Session_session_token_key` ON `Session` (`session_token`);--> statement-breakpoint
CREATE TABLE `slack_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`team_id` text NOT NULL,
	`team_name` text NOT NULL,
	`bot_token` text NOT NULL,
	`bot_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `slack_integrations_team_id_idx` ON `slack_integrations` (`team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `slack_integrations_project_id_key` ON `slack_integrations` (`project_id`);--> statement-breakpoint
CREATE TABLE `sso_configs` (
	`domain` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`auth_provider` text NOT NULL,
	`auth_config` text
);
--> statement-breakpoint
CREATE TABLE `surveys` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`survey_name` text NOT NULL,
	`response` text NOT NULL,
	`user_id` text,
	`user_email` text,
	`org_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `table_view_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`table_name` text NOT NULL,
	`created_by` text,
	`updated_by` text,
	`filters` text NOT NULL,
	`column_order` text NOT NULL,
	`column_visibility` text NOT NULL,
	`search_query` text,
	`order_by` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `table_view_presets_project_id_table_name_name_key` ON `table_view_presets` (`project_id`,`table_name`,`name`);--> statement-breakpoint
CREATE TABLE `trace_media` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`media_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`field` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trace_media_project_id_trace_id_media_id_field_key` ON `trace_media` (`project_id`,`trace_id`,`media_id`,`field`);--> statement-breakpoint
CREATE INDEX `trace_media_project_id_media_id_idx` ON `trace_media` (`project_id`,`media_id`);--> statement-breakpoint
CREATE TABLE `trace_sessions` (
	`id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`bookmarked` integer DEFAULT false NOT NULL,
	`public` integer DEFAULT false NOT NULL,
	`environment` text DEFAULT 'default' NOT NULL,
	PRIMARY KEY(`id`, `project_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trace_sessions_project_id_created_at_idx` ON `trace_sessions` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`eventSource` text NOT NULL,
	`eventActions` text NOT NULL,
	`filter` text,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `triggers_project_id_idx` ON `triggers` (`project_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`email` text,
	`email_verified` integer,
	`password` text,
	`image` text,
	`admin` integer DEFAULT false NOT NULL,
	`v4_beta_enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`feature_flags` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_key` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `verification_tokens` (
	`identifier` text NOT NULL,
	`token` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verification_tokens_identifier_token_key` ON `verification_tokens` (`identifier`,`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `verification_tokens_token_key` ON `verification_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `verified_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`domain` text NOT NULL,
	`verification_token` text NOT NULL,
	`verified_at` integer,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verified_domains_organization_id_domain_key` ON `verified_domains` (`organization_id`,`domain`);--> statement-breakpoint
CREATE INDEX `verified_domains_organization_id_idx` ON `verified_domains` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `verified_domains_verification_token_key` ON `verified_domains` (`verification_token`);--> statement-breakpoint
CREATE TABLE `web_callout_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`name` text DEFAULT 'Default' NOT NULL,
	`url` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`toast_message` text DEFAULT 'Callout sent' NOT NULL,
	`request_headers` text,
	`request_header_keys` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `web_callout_endpoints_project_id_enabled_idx` ON `web_callout_endpoints` (`project_id`,`enabled`);--> statement-breakpoint
CREATE INDEX `web_callout_endpoints_project_id_idx` ON `web_callout_endpoints` (`project_id`);