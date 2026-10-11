CREATE TABLE `io_cas_chunks` (
	`project_id` text NOT NULL,
	`content_hash` blob NOT NULL,
	`codec` integer NOT NULL,
	`raw_size` integer NOT NULL,
	`payload` blob NOT NULL,
	`mark_epoch` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `io_cas_chunks_pk` PRIMARY KEY(`project_id`, `content_hash`),
	CONSTRAINT "io_cas_chunks_content_hash_check" CHECK(length("content_hash") = 32),
	CONSTRAINT "io_cas_chunks_codec_check" CHECK("codec" IN (0, 1)),
	CONSTRAINT "io_cas_chunks_raw_size_check" CHECK("raw_size" > 0 AND "raw_size" <= 33554432),
	CONSTRAINT "io_cas_chunks_mark_epoch_check" CHECK("mark_epoch" >= 0)
);
--> statement-breakpoint
CREATE TABLE `io_cas_gc_state` (
	`project_id` text PRIMARY KEY NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`phase` text DEFAULT 'idle' NOT NULL,
	`root_cursor` text,
	`sweep_cursor` blob,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_error` text,
	CONSTRAINT "io_cas_gc_state_epoch_check" CHECK("epoch" >= 0),
	CONSTRAINT "io_cas_gc_state_phase_check" CHECK("phase" IN ('idle', 'mark', 'sweep', 'blocked')),
	CONSTRAINT "io_cas_gc_state_sweep_cursor_check" CHECK("sweep_cursor" IS NULL OR length("sweep_cursor") = 32)
);
--> statement-breakpoint
CREATE TABLE `io_cas_migration_state` (
	`project_id` text NOT NULL,
	`job` text NOT NULL,
	`pass` integer DEFAULT 1 NOT NULL,
	`cursor_id` text,
	`status` text DEFAULT 'running' NOT NULL,
	`scanned` integer DEFAULT 0 NOT NULL,
	`converted` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_error` text,
	CONSTRAINT `io_cas_migration_state_pk` PRIMARY KEY(`project_id`, `job`),
	CONSTRAINT "io_cas_migration_state_job_check" CHECK("job" IN ('backfill-v1', 'expand-v1')),
	CONSTRAINT "io_cas_migration_state_status_check" CHECK("status" IN ('running', 'paused', 'done', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_io_cas_gc` ON `io_cas_chunks` (`project_id`,`mark_epoch`,`content_hash`);