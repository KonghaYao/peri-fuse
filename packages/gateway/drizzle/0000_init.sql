CREATE TABLE `ApiKey` (
	`id` text PRIMARY KEY NOT NULL,
	`publicKey` text NOT NULL,
	`keyName` text,
	`spend` real DEFAULT 0 NOT NULL,
	`models` text DEFAULT '[]' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`maxParallel` integer,
	`tpmLimit` integer,
	`rpmLimit` integer,
	`maxBudget` real,
	`budgetId` text,
	`isEnabled` integer DEFAULT true NOT NULL,
	`lastActive` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`budgetId`) REFERENCES `Budget`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ApiKey_publicKey_unique` ON `ApiKey` (`publicKey`);--> statement-breakpoint
CREATE INDEX `ApiKey_publicKey_idx` ON `ApiKey` (`publicKey`);--> statement-breakpoint
CREATE TABLE `AuditLog` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`tableName` text NOT NULL,
	`objectId` text NOT NULL,
	`beforeValue` text,
	`afterValue` text,
	`changedBy` text DEFAULT '' NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `AuditLog_tableName_objectId_idx` ON `AuditLog` (`tableName`,`objectId`);--> statement-breakpoint
CREATE INDEX `AuditLog_createdAt_idx` ON `AuditLog` (`createdAt`);--> statement-breakpoint
CREATE TABLE `Budget` (
	`id` text PRIMARY KEY NOT NULL,
	`maxBudget` real,
	`softBudget` real,
	`maxParallel` integer,
	`tpmLimit` integer,
	`rpmLimit` integer,
	`duration` text,
	`resetAt` text,
	`modelMaxBudget` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `Credential` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`values` text NOT NULL,
	`info` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Credential_name_unique` ON `Credential` (`name`);--> statement-breakpoint
CREATE TABLE `DailySpend` (
	`id` text PRIMARY KEY NOT NULL,
	`apiKey` text NOT NULL,
	`date` text NOT NULL,
	`model` text,
	`modelGroup` text,
	`provider` text,
	`promptTokens` integer DEFAULT 0 NOT NULL,
	`completionTokens` integer DEFAULT 0 NOT NULL,
	`spend` real DEFAULT 0 NOT NULL,
	`apiRequests` integer DEFAULT 0 NOT NULL,
	`successfulRequests` integer DEFAULT 0 NOT NULL,
	`failedRequests` integer DEFAULT 0 NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `DailySpend_apiKey_date_model_provider_key` ON `DailySpend` (`apiKey`,`date`,`model`,`provider`);--> statement-breakpoint
CREATE INDEX `DailySpend_date_idx` ON `DailySpend` (`date`);--> statement-breakpoint
CREATE INDEX `DailySpend_apiKey_date_idx` ON `DailySpend` (`apiKey`,`date`);--> statement-breakpoint
CREATE INDEX `DailySpend_model_idx` ON `DailySpend` (`model`);--> statement-breakpoint
CREATE TABLE `ErrorLog` (
	`id` text PRIMARY KEY NOT NULL,
	`startTime` text NOT NULL,
	`endTime` text NOT NULL,
	`apiBase` text DEFAULT '' NOT NULL,
	`modelGroup` text DEFAULT '' NOT NULL,
	`providerModel` text DEFAULT '' NOT NULL,
	`modelId` text DEFAULT '' NOT NULL,
	`requestKwargs` text DEFAULT '{}' NOT NULL,
	`exceptionType` text DEFAULT '' NOT NULL,
	`exceptionString` text DEFAULT '' NOT NULL,
	`statusCode` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ErrorLog_startTime_idx` ON `ErrorLog` (`startTime`);--> statement-breakpoint
CREATE TABLE `ModelDeployment` (
	`id` text PRIMARY KEY NOT NULL,
	`modelName` text NOT NULL,
	`providerId` text NOT NULL,
	`providerModel` text NOT NULL,
	`litellmParams` text DEFAULT '{}' NOT NULL,
	`modelInfo` text,
	`isEnabled` integer DEFAULT true NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`providerId`) REFERENCES `Provider`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ModelDeployment_modelName_isEnabled_idx` ON `ModelDeployment` (`modelName`,`isEnabled`);--> statement-breakpoint
CREATE TABLE `Provider` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`credentialId` text,
	`baseUrl` text NOT NULL,
	`apiKeyEncrypted` text,
	`isEnabled` integer DEFAULT true NOT NULL,
	`budgetLimit` real,
	`budgetPeriod` text,
	`budgetSpend` real DEFAULT 0 NOT NULL,
	`budgetResetAt` text,
	`status` text DEFAULT 'healthy' NOT NULL,
	`cooldownUntil` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Provider_name_unique` ON `Provider` (`name`);--> statement-breakpoint
CREATE TABLE `SpendLog` (
	`id` text PRIMARY KEY NOT NULL,
	`callType` text NOT NULL,
	`apiKey` text DEFAULT '' NOT NULL,
	`spend` real DEFAULT 0 NOT NULL,
	`totalTokens` integer DEFAULT 0 NOT NULL,
	`promptTokens` integer DEFAULT 0 NOT NULL,
	`completionTokens` integer DEFAULT 0 NOT NULL,
	`startTime` text NOT NULL,
	`endTime` text NOT NULL,
	`completionStartTime` text,
	`requestDurationMs` integer,
	`model` text DEFAULT '' NOT NULL,
	`modelId` text,
	`modelGroup` text,
	`provider` text,
	`apiBase` text,
	`protocol` text,
	`user` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`requestTags` text DEFAULT '[]' NOT NULL,
	`sessionId` text,
	`status` text,
	`messages` text,
	`response` text,
	`errorMessage` text,
	`traceId` text
);
--> statement-breakpoint
CREATE INDEX `SpendLog_startTime_idx` ON `SpendLog` (`startTime`);--> statement-breakpoint
CREATE INDEX `SpendLog_apiKey_startTime_idx` ON `SpendLog` (`apiKey`,`startTime`);--> statement-breakpoint
CREATE INDEX `SpendLog_model_startTime_idx` ON `SpendLog` (`model`,`startTime`);--> statement-breakpoint
CREATE INDEX `SpendLog_sessionId_idx` ON `SpendLog` (`sessionId`);