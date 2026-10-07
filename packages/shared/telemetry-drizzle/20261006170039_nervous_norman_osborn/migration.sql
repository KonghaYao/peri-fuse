CREATE TABLE `daily_model_stats` ( `project_id` text NOT NULL, `day` text NOT NULL, `model` text NOT NULL, `observations` integer DEFAULT 0 NOT NULL, `tokens` integer DEFAULT 0 NOT NULL, `lat_count` integer DEFAULT 0 NOT NULL, `lat_sum_ms` real DEFAULT 0 NOT NULL, `lat_hist` text DEFAULT '[]' NOT NULL, CONSTRAINT `daily_model_stats_pk` PRIMARY KEY(`project_id`, `day`, `model`) );
--> statement-breakpoint
CREATE TABLE `daily_stats` ( `project_id` text NOT NULL, `day` text NOT NULL, `traces` integer DEFAULT 0 NOT NULL, `users_json` text DEFAULT '[]' NOT NULL, `observations` integer DEFAULT 0 NOT NULL, `generations` integer DEFAULT 0 NOT NULL, `errors` integer DEFAULT 0 NOT NULL, `warnings` integer DEFAULT 0 NOT NULL, `debugs` integer DEFAULT 0 NOT NULL, `tokens` integer DEFAULT 0 NOT NULL, `cached_tokens` integer DEFAULT 0 NOT NULL, `gross_input_tokens` integer DEFAULT 0 NOT NULL, `scores_count` integer DEFAULT 0 NOT NULL, `scores_val_count` integer DEFAULT 0 NOT NULL, `score_sum` real DEFAULT 0 NOT NULL, `lat_count` integer DEFAULT 0 NOT NULL, `lat_sum_ms` real DEFAULT 0 NOT NULL, `lat_hist` text DEFAULT '[]' NOT NULL, `updated_at` text DEFAULT (datetime('now')) NOT NULL, CONSTRAINT `daily_stats_pk` PRIMARY KEY(`project_id`, `day`) );
--> statement-breakpoint
CREATE TABLE `dataset_run_items` ( `id` text NOT NULL, `project_id` text NOT NULL, `dataset_run_id` text NOT NULL, `dataset_item_id` text NOT NULL, `dataset_id` text NOT NULL, `trace_id` text NOT NULL, `observation_id` text, `error` text, `dataset_item_valid_from` text, `dataset_version` text, `created_at` text DEFAULT (datetime('now')) NOT NULL, `updated_at` text DEFAULT (datetime('now')) NOT NULL, `event_ts` text DEFAULT (datetime('now')) NOT NULL, `is_deleted` integer DEFAULT 0, CONSTRAINT `dataset_run_items_pk` PRIMARY KEY(`project_id`, `id`) );
--> statement-breakpoint
CREATE TABLE `observations` ( `id` text NOT NULL, `project_id` text NOT NULL, `trace_id` text, `parent_observation_id` text, `type` text DEFAULT 'SPAN' NOT NULL, `name` text, `start_time` text DEFAULT (datetime('now')) NOT NULL, `end_time` text, `metadata` text DEFAULT '{}', `model` text, `input` blob, `input_codec` integer DEFAULT 0 NOT NULL, `input_raw_size` integer, `output` blob, `output_codec` integer DEFAULT 0 NOT NULL, `output_raw_size` integer, `level` text DEFAULT 'DEFAULT', `status_message` text, `completion_start_time` text, `prompt_id` text, `prompt_name` text, `prompt_version` integer, `model_parameters` text DEFAULT '{}', `usage_details` text DEFAULT '{}', `cost_details` text DEFAULT '{}', `provided_usage_details` text DEFAULT '{}', `provided_cost_details` text DEFAULT '{}', `total_cost` real, `version` text, `created_at` text DEFAULT (datetime('now')) NOT NULL, `updated_at` text DEFAULT (datetime('now')) NOT NULL, `event_ts` text DEFAULT (datetime('now')) NOT NULL, `is_deleted` integer DEFAULT 0, `environment` text DEFAULT 'default', CONSTRAINT `observations_pk` PRIMARY KEY(`project_id`, `id`) );
--> statement-breakpoint
CREATE TABLE `scores` ( `id` text NOT NULL, `project_id` text NOT NULL, `trace_id` text, `observation_id` text, `name` text NOT NULL, `value` real, `string_value` text, `source` text DEFAULT 'API' NOT NULL, `comment` text, `author_user_id` text, `config_id` text, `data_type` text DEFAULT 'NUMERIC' NOT NULL, `timestamp` text DEFAULT (datetime('now')) NOT NULL, `created_at` text DEFAULT (datetime('now')) NOT NULL, `updated_at` text DEFAULT (datetime('now')) NOT NULL, `event_ts` text DEFAULT (datetime('now')) NOT NULL, `is_deleted` integer DEFAULT 0, `environment` text DEFAULT 'default', `queue_id` text, `metadata` text DEFAULT '{}', `session_id` text, CONSTRAINT `scores_pk` PRIMARY KEY(`project_id`, `id`) );
--> statement-breakpoint
CREATE TABLE `search_occurrences` ( `occurrence_id` text PRIMARY KEY, `project_id` text NOT NULL, `text_id` integer NOT NULL, `source_kind` text NOT NULL, `source_id` text NOT NULL, `trace_id` text, `role` text NOT NULL, `field` text NOT NULL, `message_order` integer NOT NULL, `chunk_no` integer NOT NULL, `source_version` integer NOT NULL, `event_time` text NOT NULL, `session_id` text, `display_start` integer DEFAULT 0 NOT NULL, `display_end` integer DEFAULT 0 NOT NULL );
--> statement-breakpoint
CREATE TABLE `search_texts` ( `text_id` integer PRIMARY KEY, `project_id` text NOT NULL, `content_hash` text NOT NULL, `chunk_no` integer NOT NULL, `display_text` text NOT NULL, `normalized_text` text NOT NULL, `project_scope` text NOT NULL, `index_version` integer DEFAULT 1 NOT NULL );
--> statement-breakpoint
CREATE TABLE `search_trigrams` ( `project_id` text NOT NULL, `gram` text NOT NULL, `text_id` integer NOT NULL, CONSTRAINT `search_trigrams_pk` PRIMARY KEY(`project_id`, `gram`, `text_id`) );
--> statement-breakpoint
CREATE TABLE `trace_metrics` ( `project_id` text NOT NULL, `trace_id` text, `user_id` text, `session_id` text, `obs_count` integer DEFAULT 0, `total_cost` real DEFAULT 0, `input_cost` real DEFAULT 0, `output_cost` real DEFAULT 0, `input_tokens` integer DEFAULT 0, `output_tokens` integer DEFAULT 0, `total_tokens` integer DEFAULT 0, `cached_tokens` integer DEFAULT 0, `cache_creation_tokens` integer DEFAULT 0, `gross_input_tokens` integer DEFAULT 0, `timestamp` text, CONSTRAINT `trace_metrics_pk` PRIMARY KEY(`project_id`, `trace_id`) );
--> statement-breakpoint
CREATE TABLE `traces` ( `id` text NOT NULL, `project_id` text NOT NULL, `timestamp` text DEFAULT (datetime('now')) NOT NULL, `name` text, `user_id` text, `metadata` text DEFAULT '{}', `release` text, `version` text, `public` integer DEFAULT 0, `bookmarked` integer DEFAULT 0, `tags` text DEFAULT '[]', `input` blob, `input_codec` integer DEFAULT 0 NOT NULL, `input_raw_size` integer, `output` blob, `output_codec` integer DEFAULT 0 NOT NULL, `output_raw_size` integer, `session_id` text, `created_at` text DEFAULT (datetime('now')) NOT NULL, `updated_at` text DEFAULT (datetime('now')) NOT NULL, `event_ts` text DEFAULT (datetime('now')) NOT NULL, `is_deleted` integer DEFAULT 0, `environment` text DEFAULT 'default', CONSTRAINT `traces_pk` PRIMARY KEY(`project_id`, `id`) );
--> statement-breakpoint
CREATE TABLE `daily_stats_dirty` ( `project_id` text NOT NULL, `day` text NOT NULL, `revision` integer DEFAULT 1 NOT NULL, `dirty` integer DEFAULT 1 NOT NULL, CONSTRAINT `daily_stats_dirty_pk` PRIMARY KEY(`project_id`, `day`) );
--> statement-breakpoint
CREATE TABLE `ingestion_field_versions` ( `project_id` text NOT NULL, `entity_type` text NOT NULL, `entity_id` text NOT NULL, `versions` text NOT NULL, CONSTRAINT `ingestion_field_versions_pk` PRIMARY KEY(`project_id`, `entity_type`, `entity_id`) );
--> statement-breakpoint
CREATE TABLE `search_dirty` ( `project_id` text NOT NULL, `source_kind` text NOT NULL, `source_id` text NOT NULL, `revision` integer NOT NULL, `event_time` text, `attempts` integer DEFAULT 0 NOT NULL, `next_attempt_at` text, `last_error` text, CONSTRAINT `search_dirty_pk` PRIMARY KEY(`project_id`, `source_kind`, `source_id`) );
--> statement-breakpoint
CREATE TABLE `search_index_state` ( `project_id` text PRIMARY KEY, `index_version` integer DEFAULT 1 NOT NULL, `coverage` text DEFAULT 'new' NOT NULL, `pending` integer DEFAULT 0 NOT NULL, `trace_cursor` integer DEFAULT 0 NOT NULL, `observation_cursor` integer DEFAULT 0 NOT NULL, `last_error` text, `updated_at` text DEFAULT (datetime('now')) NOT NULL );
--> statement-breakpoint
CREATE TABLE `search_source_revisions` ( `project_id` text NOT NULL, `source_kind` text NOT NULL, `source_id` text NOT NULL, `revision` integer NOT NULL, CONSTRAINT `search_source_revisions_pk` PRIMARY KEY(`project_id`, `source_kind`, `source_id`) );
--> statement-breakpoint
CREATE TABLE `telemetry_retention_state` ( `id` integer PRIMARY KEY, `cutoff_day` text NOT NULL, CONSTRAINT "telemetry_retention_state_id_check" CHECK("id" = 1) );
--> statement-breakpoint
CREATE INDEX `idx_dri_project_run` ON `dataset_run_items` (`project_id`,`dataset_run_id`);
--> statement-breakpoint
CREATE INDEX `idx_dri_project_item` ON `dataset_run_items` (`project_id`,`dataset_item_id`);
--> statement-breakpoint
CREATE INDEX `idx_dri_project_trace` ON `dataset_run_items` (`project_id`,`trace_id`);
--> statement-breakpoint
CREATE INDEX `idx_observations_project_trace` ON `observations` (`project_id`,`trace_id`);
--> statement-breakpoint
CREATE INDEX `idx_observations_project_start` ON `observations` (`project_id`,`start_time`);
--> statement-breakpoint
CREATE INDEX `idx_observations_project_type` ON `observations` (`project_id`,`type`);
--> statement-breakpoint
CREATE INDEX `idx_obs_deleted_name` ON `observations` (`project_id`,`is_deleted`,`name`);
--> statement-breakpoint
CREATE INDEX `idx_obs_start_cost` ON `observations` (`project_id`,`is_deleted`,`start_time`,`total_cost`);
--> statement-breakpoint
CREATE INDEX `idx_obs_type_start_model` ON `observations` (`project_id`,`is_deleted`,`type`,`start_time`,`model`,`total_cost`);
--> statement-breakpoint
CREATE INDEX `idx_obs_start_level` ON `observations` (`project_id`,`is_deleted`,`start_time`,`level`);
--> statement-breakpoint
CREATE INDEX `idx_obs_error_start` ON `observations` (`project_id`,`is_deleted`,`level`,`start_time`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_obs_type_level_start` ON `observations` (`project_id`,`is_deleted`,`type`,`level`,`start_time`);
--> statement-breakpoint
CREATE INDEX `idx_scores_project_ts` ON `scores` (`project_id`,`timestamp`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_scores_project_trace` ON `scores` (`project_id`,`trace_id`);
--> statement-breakpoint
CREATE INDEX `idx_scores_project_name` ON `scores` (`project_id`,`name`);
--> statement-breakpoint
CREATE INDEX `idx_search_occ_window` ON `search_occurrences` (`project_id`,`event_time`,`occurrence_id`,`text_id`);
--> statement-breakpoint
CREATE INDEX `idx_search_occ_source` ON `search_occurrences` (`project_id`,`source_kind`,`source_id`);
--> statement-breakpoint
CREATE INDEX `idx_search_occ_text` ON `search_occurrences` (`project_id`,`text_id`);
--> statement-breakpoint
CREATE INDEX `idx_search_occ_context` ON `search_occurrences` (`project_id`,`source_kind`,`source_id`,`source_version`,`message_order`,`chunk_no`);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_texts_project_id_content_hash_chunk_no_index_version_unique` ON `search_texts` (`project_id`,`content_hash`,`chunk_no`,`index_version`);
--> statement-breakpoint
CREATE INDEX `idx_search_trigrams_text` ON `search_trigrams` (`project_id`,`text_id`);
--> statement-breakpoint
CREATE INDEX `idx_trace_metrics_session` ON `trace_metrics` (`project_id`,`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_trace_metrics_user` ON `trace_metrics` (`project_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_trace_metrics_ts` ON `trace_metrics` (`project_id`,`timestamp`);
--> statement-breakpoint
CREATE INDEX `idx_traces_project_timestamp` ON `traces` (`project_id`,`timestamp`);
--> statement-breakpoint
CREATE INDEX `idx_traces_project_session` ON `traces` (`project_id`,`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_traces_project_name` ON `traces` (`project_id`,`name`);
--> statement-breakpoint
CREATE INDEX `idx_traces_deleted_session` ON `traces` (`project_id`,`is_deleted`,`session_id`,`timestamp`,`user_id`,`environment`,`tags`);
--> statement-breakpoint
CREATE INDEX `idx_traces_deleted_user` ON `traces` (`project_id`,`is_deleted`,`user_id`,`timestamp`,`environment`);
