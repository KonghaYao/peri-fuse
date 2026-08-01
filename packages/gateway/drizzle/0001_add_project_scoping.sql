-- Migration: Add projectId scoping to all gateway tables
-- This migration adds project-level isolation to align with the server's org/project model.

ALTER TABLE `Provider` ADD COLUMN `projectId` TEXT;--> statement-breakpoint
ALTER TABLE `Credential` ADD COLUMN `projectId` TEXT;--> statement-breakpoint
ALTER TABLE `ModelDeployment` ADD COLUMN `projectId` TEXT;--> statement-breakpoint
ALTER TABLE `ApiKey` ADD COLUMN `projectId` TEXT;--> statement-breakpoint
ALTER TABLE `Budget` ADD COLUMN `projectId` TEXT;--> statement-breakpoint
ALTER TABLE `SpendLog` ADD COLUMN `projectId` TEXT DEFAULT '';--> statement-breakpoint
ALTER TABLE `DailySpend` ADD COLUMN `projectId` TEXT DEFAULT '';--> statement-breakpoint
ALTER TABLE `ErrorLog` ADD COLUMN `projectId` TEXT DEFAULT '';--> statement-breakpoint
ALTER TABLE `AuditLog` ADD COLUMN `projectId` TEXT DEFAULT '';--> statement-breakpoint

-- Backfill: set existing rows to empty string (will be treated as "unscoped legacy")
UPDATE `Provider` SET `projectId` = '' WHERE `projectId` IS NULL;--> statement-breakpoint
UPDATE `Credential` SET `projectId` = '' WHERE `projectId` IS NULL;--> statement-breakpoint
UPDATE `ModelDeployment` SET `projectId` = '' WHERE `projectId` IS NULL;--> statement-breakpoint
UPDATE `ApiKey` SET `projectId` = '' WHERE `projectId` IS NULL;--> statement-breakpoint
UPDATE `Budget` SET `projectId` = '' WHERE `projectId` IS NULL;--> statement-breakpoint

-- Drop old unique indexes
DROP INDEX IF EXISTS `Provider_name_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `Credential_name_unique`;--> statement-breakpoint

-- Create new composite unique indexes
CREATE UNIQUE INDEX `Provider_projectId_name_key` ON `Provider` (`projectId`, `name`);--> statement-breakpoint
CREATE UNIQUE INDEX `Credential_projectId_name_key` ON `Credential` (`projectId`, `name`);--> statement-breakpoint

-- Create projectId indexes
CREATE INDEX `Provider_projectId_idx` ON `Provider` (`projectId`);--> statement-breakpoint
CREATE INDEX `Credential_projectId_idx` ON `Credential` (`projectId`);--> statement-breakpoint
CREATE INDEX `ModelDeployment_projectId_idx` ON `ModelDeployment` (`projectId`);--> statement-breakpoint
CREATE INDEX `ApiKey_projectId_idx` ON `ApiKey` (`projectId`);--> statement-breakpoint
CREATE INDEX `Budget_projectId_idx` ON `Budget` (`projectId`);--> statement-breakpoint
CREATE INDEX `SpendLog_projectId_idx` ON `SpendLog` (`projectId`);--> statement-breakpoint
CREATE INDEX `DailySpend_projectId_idx` ON `DailySpend` (`projectId`);--> statement-breakpoint
CREATE INDEX `ErrorLog_projectId_idx` ON `ErrorLog` (`projectId`);--> statement-breakpoint
CREATE INDEX `AuditLog_projectId_idx` ON `AuditLog` (`projectId`);
